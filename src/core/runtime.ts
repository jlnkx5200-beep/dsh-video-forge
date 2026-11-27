/**
 * Runtime —— 把 config / providers / cache / scheduler / bridge 装配成一个可用服务。
 *
 * 职责边界：
 *   - 只管"跑一次生产"：编译 DAG → 调度 → 落盘 → 回填 RenderPlan → 同步资产到 Remotion public
 *   - 不认识的风格一律不处理（preset 名只做字符串透传）
 *   - 事件流用环形缓冲 + 轮询（面板 700ms 拉一次）；SSE 留给需要时的增强，不作为默认
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import type { ForgePaths } from './config.js'
import { ForgeCache } from './cache.js'
import { ProviderRegistry } from './providers/index.js'
import type { Artifact, ProviderConfig, RunEvent, TaskResult } from './providers/types.js'
import { Scheduler, type TaskNode } from './scheduler.js'
import { compileStoryboard, type CompileOptions, type StoryboardInput } from '../bridge/compiler.js'
import type { RenderPlan, ShotPlan } from '../bridge/render-plan.js'
import { validatePlan, type PlanIssue } from '../bridge/render-plan.js'
import { alphaCoverage } from './png.js'

export interface RuntimeOptions {
  config: () => ProviderConfig
  paths: () => ForgePaths
  /** 插件根目录（用来定位 remotion/ 子工程） */
  pluginRoot: string
  /** 事件缓冲上限 */
  eventBuffer?: number
  /**
   * 背景板守卫下界：matte 前景像素占比低于该值时不采用 plate
   * （默认 1.5% —— 再低就只剩黑孔，拆出来是坏图而不是背景）。
   */
  plateMinCoverage?: number
  /**
   * 背景板守卫上界：前景占比高于该值同样不采用 plate
   * （默认 92% —— BiRefNet 在无主体风景上会把整图判成前景，
   * 此时「背景板」= 整张图补洞后的黑块，比黑孔更糟）。
   */
  plateMaxCoverage?: number
  /** ComfyUI（GPU）池并发，默认 1 */
  gpuConcurrency?: number
}

/** 背景板守卫默认阈值（前景占比下界）。 */
const DEFAULT_PLATE_MIN_COVERAGE = 0.015
/** 背景板守卫默认阈值（前景占比上界）。 */
const DEFAULT_PLATE_MAX_COVERAGE = 0.92

/**
 * 作业状态：`pending_quota` = 官方 Sand.ai 已鉴权但配额未下发（2026-11 现状）。
 * 它不是失败：作业原样保留 requestSnapshot，配额到位后一键重放即可。
 */
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'pending_quota'

export interface JobRecord {
  id: string
  planId: string
  title: string
  status: JobStatus
  startedAt: number
  endedAt?: number
  mock: boolean
  dryRun: boolean
  progress: { done: number; total: number; label: string }
  events: RunEvent[]
  planPath?: string
  planJsonPath?: string
  error?: string
  stats?: Record<string, unknown>
  /** 提交时的完整参数快照（已脱敏，绝不含任何密钥）：面板「按原参数重跑」与配额到位后「一键重放」的唯一依据 */
  requestSnapshot?: Record<string, unknown>
  /** 待官方配额：作业停在可重放状态，等配额下发 */
  pendingQuota?: { taskId: string; provider: string; error: string }
  issues: PlanIssue[]
  results: Array<{ id: string; provider: string; ok: boolean; cached: boolean; seconds: number; artifacts: number; error?: string; warnings: string[] }>
}

/**
 * 提交参数快照 —— P0-1「按原参数重跑」与 pending_quota「一键重放」的唯一数据源。
 * 只收分镜与调度参数；任何密钥都不在这条路径上（config 由 Provider 在执行时自行解析）。
 */
function snapshotOf(storyboard: StoryboardInput, options: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'defaultStrategy', 'seedreamModel', 'minimaxModel', 'minimaxResolution', 'depthWorkflow',
    'matteWorkflow', 'plateWorkflow', 'enablePlate', 'preset', 'qualityMode', 'appendStyleTags',
    'promptWithNegative', 'mock', 'dryRun', 'useCache', 'writePlan', 'concurrency',
  ]
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    const value = options[key]
    if (value !== undefined) picked[key] = value
  }
  return { storyboard, options: picked, capturedAt: new Date().toISOString() }
}

function newId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  return prefix + '-' + stamp
}

export class ForgeRuntime {
  private readonly cache: ForgeCache
  private readonly registry: ProviderRegistry
  private readonly jobs = new Map<string, JobRecord>()
  /** 每个运行中作业一个 AbortController：POST /jobs/:id/cancel 真正中断排队 + 轮询 */
  private readonly controllers = new Map<string, AbortController>()
  private readonly clientId: string

  constructor(private readonly opts: RuntimeOptions) {
    this.cache = new ForgeCache(opts.paths().cacheDir)
    this.clientId = 'dsh-video-forge-' + createHash('sha1').update(String(process.pid)).digest('hex').slice(0, 8)
    this.registry = new ProviderRegistry({
      config: opts.config,
      clientId: () => this.clientId,
    })
  }

  get providers(): ProviderRegistry {
    return this.registry
  }

  get cacheStore(): ForgeCache {
    return this.cache
  }

  paths(): ForgePaths {
    return this.opts.paths()
  }

  /** 落盘一个产物到 outDir/<sub>/<name>，返回带 fileKey/url 的 Artifact。 */
  saveArtifact(sub: string, fileName: string, bytes: Buffer, meta: { id?: string; kind?: Artifact['kind']; mime?: string; width?: number; height?: number; durationSec?: number; meta?: Record<string, unknown> } = {}): Artifact {
    const dir = join(this.opts.paths().outDir, sub)
    mkdirSync(dir, { recursive: true })
    let name = basename(fileName).replace(/[^\w.\-]+/g, '_')
    if (name === '' || name === '.' || name === '..') name = 'artifact.bin'
    const path = join(dir, name)
    writeFileSync(path, bytes)
    const fileKey = 'o/' + sub + '/' + name
    return {
      id: meta.id ?? name,
      kind: meta.kind ?? (path.endsWith('.mp4') ? 'video' : 'image'),
      path,
      url: '/api/dsh-video-forge/file/' + fileKey.split('/').map(encodeURIComponent).join('/'),
      fileKey,
      bytes: bytes.length,
      mime: meta.mime,
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
      meta: meta.meta ?? {},
    }
  }

  private pushEvent(job: JobRecord, event: RunEvent): void {
    job.events.push(event)
    const cap = this.opts.eventBuffer ?? 400
    if (job.events.length > cap) job.events.splice(0, job.events.length - cap)
    if (event.type === 'done' || event.type === 'skip' || event.type === 'error') {
      const finished = job.results.filter(r => r.id === event.taskId).length
      job.progress.done = Math.min(job.progress.total, Math.max(job.progress.done, finished + (event.type === 'done' ? 1 : 0)))
    }
    job.progress.label = event.message ?? event.type
  }

  /** 预生成作业 id（路由在 202 响应里立刻交出 id，前端不再靠定时刷新猜）。 */
  nextJobId(prefix = 'job'): string {
    return newId(prefix)
  }

  getJob(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  listJobs(limit = 20): Array<Omit<JobRecord, 'events'> & { eventCount: number }> {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(({ events, ...rest }) => ({ ...rest, eventCount: events.length }))
  }

  /**
   * 主流程：分镜 → DAG → 调度 → RenderPlan（资产已回填并同步到 remotion/public）。
   * 返回 job 记录（已完成/失败都已终结），供工具与面板直接消费。
   */
  async produce(
    storyboard: StoryboardInput,
    options: CompileOptions & {
      mock?: boolean
      dryRun?: boolean
      useCache?: boolean
      concurrency?: number
      writePlan?: boolean
      signal?: AbortSignal
      /** 预生成的作业 id（HTTP 202 需要立刻把 id 交给前端，避免 800ms 盲猜刷新） */
      jobId?: string
      /** 作业登记后立即回调（同一个同步 tick 内），路由据此拿到 id 与状态快照 */
      onJob?: (job: JobRecord) => void
    } = {},
  ): Promise<JobRecord> {
    const paths = this.opts.paths()
    const compiled = compileStoryboard(storyboard, options)
    const plan = compiled.plan
    const controller = new AbortController()
    const job: JobRecord = {
      id: options.jobId ?? newId('job'),
      planId: plan.id,
      title: plan.title,
      status: 'running',
      startedAt: Date.now(),
      mock: options.mock === true,
      dryRun: options.dryRun === true,
      progress: { done: 0, total: compiled.tasks.length, label: '编译完成，等待调度' },
      events: [],
      issues: compiled.issues,
      requestSnapshot: snapshotOf(storyboard, options as unknown as Record<string, unknown>),
      results: [],
    }
    this.controllers.set(job.id, controller)
    job.results = compiled.tasks.map(task => ({ id: task.id, provider: task.provider, ok: false, cached: false, seconds: 0, artifacts: 0, warnings: [] }))
    this.jobs.set(job.id, job)
    this.pushEvent(job, { type: 'queued', taskId: '*', provider: '*', at: Date.now(), message: 'job ' + job.id + ' 已创建：' + compiled.tasks.length + ' 个任务' })
    options.onJob?.(job)

    // 外部信号（工具调用方）与作业自身的取消控制器合并：任一触发都真正中断在跑的任务
    const signals = [controller.signal]
    if (options.signal !== undefined) signals.push(options.signal)
    const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
    const signal = typeof anyFn === 'function' ? anyFn(signals) : controller.signal

    const scheduler = new Scheduler({
      registry: this.registry,
      signal,
      cache: this.cache,
      config: this.opts.config,
      saveArtifact: (sub, fileName, bytes, meta) => this.saveArtifact(sub, fileName, bytes, meta),
      tmpDir: paths.tmpDir,
      concurrency: options.concurrency ?? 3,
      gpuConcurrency: this.opts.gpuConcurrency ?? 1,
      mock: options.mock === true,
      dryRun: options.dryRun === true,
      useCache: options.useCache !== false,
      onEvent: event => {
        this.pushEvent(job, event)
        const row = job.results.find(item => item.id === event.taskId)
        if (row !== undefined && (event.type === 'done' || event.type === 'cache' || event.type === 'skip' || event.type === 'error')) {
          row.ok = event.type === 'done' || event.type === 'cache'
          row.cached = event.type === 'cache'
          if (event.message !== undefined) row.warnings = [event.message]
          if (event.type === 'error') row.error = event.message
        }
      },
    })

    try {
      const run = await scheduler.run(compiled.tasks)
      for (const task of compiled.tasks) {
        const result = run.results.get(task.id)
        const row = job.results.find(item => item.id === task.id)
        if (row === undefined) continue
        if (result !== undefined) {
          row.ok = result.ok
          row.cached = result.cached
          row.seconds = result.seconds
          row.artifacts = result.artifacts.length
          row.warnings = result.warnings
          row.error = result.error
        }
        this.fillShotAsset(plan, task, result)
      }

      // 背景板守卫：matte 前景占比过低时，plate 拆出来只会是黑孔图。
      // 与其把坏图交给渲染机，不如自动降级为「无背景板」并留一条可观测的 warn。
      const guardIssues = this.applyPlateGuard(plan, run.results)

      const issues = validatePlan(plan)
      job.issues = [...compiled.issues, ...guardIssues, ...issues]
      const fatal = issues.filter(issue => issue.level === 'error')
      job.stats = { ...run.stats, providerCalls: run.stats.providerCalls }

      // 取消与待配额优先于"失败"判定：这两者都不是错误。
      if (run.cancelled === true) {
        job.status = 'cancelled'
        job.error = '已取消'
        this.pushEvent(job, { type: 'error', taskId: '*', provider: '*', at: Date.now(), message: '作业已取消' })
        return this.finish(job)
      }
      if (run.pendingQuota !== undefined) {
        job.status = 'pending_quota'
        job.pendingQuota = {
          taskId: run.pendingQuota.taskId,
          provider: run.pendingQuota.provider,
          error: run.pendingQuota.error,
        }
        job.error = '官方配额未下发（已鉴权）：Sand.ai 返回 400 insufficient_credits。Key 与参数均已校验通过，配额下发后可一键重放。'
        this.pushEvent(job, {
          type: 'error', taskId: run.pendingQuota.taskId, provider: run.pendingQuota.provider, at: Date.now(),
          message: 'pending_quota：作业草稿已保留，等待官方配额下发',
        })
        return this.finish(job)
      }

      if (fatal.length > 0 && options.dryRun !== true) {
        job.status = 'failed'
        job.error = 'RenderPlan 校验失败：' + fatal.slice(0, 3).map(i => (i.shotId ?? '') + ' ' + i.message).join(' / ')
        this.pushEvent(job, { type: 'error', taskId: '*', provider: '*', at: Date.now(), message: job.error })
        return this.finish(job)
      }

      if (options.writePlan !== false) {
        const written = this.writePlan(plan, job)
        job.planPath = written.remotionPlanPath
        job.planJsonPath = written.hostPlanPath
      }
      if (run.stats.failed > 0) {
        job.status = 'failed'
        job.error = run.stats.failed + ' 个任务失败（详见 results）'
      } else {
        job.status = 'done'
      }
      this.pushEvent(job, { type: 'done', taskId: '*', provider: '*', at: Date.now(), message: 'job ' + job.status + '：' + run.stats.ok + ' 成功 / ' + run.stats.cached + ' 缓存 / ' + run.stats.skipped + ' 跳过' })
      return this.finish(job)
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      this.pushEvent(job, { type: 'error', taskId: '*', provider: '*', at: Date.now(), message: job.error })
      return this.finish(job)
    }
  }

  private finish(job: JobRecord): JobRecord {
    job.endedAt = Date.now()
    job.progress.done = job.progress.total
    this.controllers.delete(job.id)
    return job
  }

  /**
   * 取消作业：中止排队任务、中止 Provider 轮询、把作业置 cancelled 并写增量事件。
   * ok=false 时 reason 说明原因（作业不存在 / 已结束 / 无可取消上下文）。
   */
  cancelJob(id: string): { ok: boolean; job?: JobRecord; reason?: string } {
    const job = this.jobs.get(id)
    if (job === undefined) return { ok: false, reason: '作业不存在：' + id }
    if (job.status !== 'running') return { ok: false, job, reason: '作业已结束（' + job.status + '），无需取消' }
    const controller = this.controllers.get(id)
    if (controller === undefined) return { ok: false, job, reason: '作业没有可取消的执行上下文' }
    this.pushEvent(job, { type: 'log', taskId: '*', provider: '*', at: Date.now(), message: '收到取消请求，正在中止' })
    controller.abort()
    return { ok: true, job }
  }

  /** 待配额作业一键重放：用 requestSnapshot 原样再跑一次（配额到位后即可产出）。 */
  async replay(id: string): Promise<JobRecord> {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error('作业不存在：' + id)
    if (job.requestSnapshot === undefined) throw new Error('该作业没有参数快照，无法重放')
    const snapshot = job.requestSnapshot
    const storyboard = snapshot['storyboard'] as StoryboardInput
    const options = (snapshot['options'] ?? {}) as CompileOptions & {
      mock?: boolean; dryRun?: boolean; useCache?: boolean; concurrency?: number; writePlan?: boolean
    }
    return this.produce(storyboard, options)
  }

  /** 计划里每个镜头的可直接预览 fileKey 映射（对接 GET /file/<fileKey>）。 */
  planPreview(plan: RenderPlan): Array<Record<string, unknown>> {
    const fileKeyOf = (url: string | undefined): string | null => {
      if (url === undefined || url === '') return null
      const marker = '/file/'
      const index = url.indexOf(marker)
      if (index < 0) return null
      return decodeURIComponent(url.slice(index + marker.length))
    }
    return plan.shots.map((shot) => {
      const keys = {
        still: fileKeyOf(shot.assets.still),
        plate: fileKeyOf(shot.assets.plate),
        depth: fileKeyOf(shot.assets.depth),
        matte: fileKeyOf(shot.assets.matte),
        video: fileKeyOf(shot.assets.video),
      }
      const primary = keys.video ?? keys.still
      return {
        id: shot.id,
        index: shot.index,
        from: shot.from,
        durationInFrames: shot.durationInFrames,
        strategy: shot.strategy,
        caption: shot.caption,
        fileKeys: keys,
        previewUrl: primary === null
          ? null
          : '/api/dsh-video-forge/file/' + primary.split('/').map(encodeURIComponent).join('/'),
      }
    })
  }

  /** 把某个任务的产物填回对应镜头的 assets 槽。 */
  /**
   * 背景板守卫：用真 matte 的 alpha 覆盖率判断「这张图到底有没有主体」。
   * 双侧校验：太干净（< 1.5%，只有黑孔）和太满（> 92%，整图被判成前景、背景板成黑洞）
   * 都不采用 plate。覆盖率读不出来（非 PNG / 无 alpha）时保守保留 plate —— 宁可不动，也不误删。
   */
  private applyPlateGuard(plan: RenderPlan, results: Map<string, TaskResult>): PlanIssue[] {
    const issues: PlanIssue[] = []
    const minCoverage = this.opts.plateMinCoverage ?? DEFAULT_PLATE_MIN_COVERAGE
    const maxCoverage = this.opts.plateMaxCoverage ?? DEFAULT_PLATE_MAX_COVERAGE
    const measured: Array<{ shotId: string; coverage: number; kept: boolean }> = []
    for (const shot of plan.shots) {
      const plate = shot.assets.plate
      if (plate === undefined || plate === '') continue
      const mattePath = results.get(shot.id + ':matte')?.artifacts[0]?.path
      if (mattePath === undefined) continue
      const coverage = alphaCoverage(mattePath)
      if (coverage === null) continue
      const tooClean = coverage < minCoverage
      const tooFull = coverage > maxCoverage
      const kept = !tooClean && !tooFull
      measured.push({ shotId: shot.id, coverage: Number(coverage.toFixed(4)), kept })
      if (kept) continue
      delete shot.assets.plate
      const percent = (coverage * 100).toFixed(2) + '%'
      issues.push({
        level: 'warn',
        shotId: shot.id,
        message: tooClean
          ? 'matte 前景占比 ' + percent + ' 低于下界 ' + (minCoverage * 100).toFixed(1) +
            '%，已跳过背景板（拆出来只会是黑孔）'
          : 'matte 前景占比 ' + percent + ' 高于上界 ' + (maxCoverage * 100).toFixed(1) +
            '%（整图被判成前景、没有可拆的背景），已跳过背景板（拆出来只会是黑洞）',
      })
    }
    if (measured.length > 0 && plan.provenance !== undefined) {
      plan.provenance['plateGuard'] = measured
    }
    return issues
  }

  private fillShotAsset(plan: RenderPlan, task: TaskNode, result: TaskResult | undefined): void {
    if (result === undefined || !result.ok) return
    const [shotId, role] = task.id.split(':')
    const shot = plan.shots.find(item => item.id === shotId)
    if (shot === undefined) return
    const artifact = result.artifacts[0]
    if (artifact === undefined) return
    const src = artifact.url
    if (role === 'still') {
      shot.assets.still = src
      if (shot.layer !== undefined) shot.layer.src = src
    } else if (role === 'depth') {
      shot.assets.depth = src
      if (shot.layer !== undefined) shot.layer.depthSrc = src
    } else if (role === 'matte') {
      shot.assets.matte = src
      if (shot.layer !== undefined) shot.layer.matteSrc = src
    } else if (role === 'plate') {
      shot.assets.plate = src
    } else if (role === 'video') {
      shot.assets.video = src
      if (shot.video !== undefined) shot.video.src = src
      // 有视频时默认不再用静帧做主体（除非镜头同时声明了 layer 需求）
      if (shot.layer !== undefined && shot.layer.src === '' && shot.assets.still === undefined) {
        shot.layer = undefined
      }
    }
  }

  /**
   * 写 RenderPlan 两份：
   *   - 宿主侧：<plans>/<planId>/plan.json（带 /api/... 绝对 URL，面板可预览）
   *   - Remotion 侧：remotion/public/forge/<planId>/plan.json（src 改写为 staticFile 相对路径，资产硬链接过去）
   */
  writePlan(plan: RenderPlan, job: JobRecord): { hostPlanPath: string; remotionPlanPath: string } {
    const paths = this.opts.paths()
    const planDir = join(paths.plansDir, plan.id)
    mkdirSync(planDir, { recursive: true })

    const hostPlan: RenderPlan = { ...plan, provenance: { ...(plan.provenance ?? {}), job: job.id, producedAt: new Date().toISOString() } }
    const hostPlanPath = join(planDir, 'plan.json')
    writeFileSync(hostPlanPath, JSON.stringify(hostPlan, null, 2), 'utf8')

    const publicDir = join(this.opts.pluginRoot, 'remotion', 'public', 'forge', plan.id)
    mkdirSync(publicDir, { recursive: true })
    const remotionPlan = this.relocateAssets(hostPlan, publicDir)
    const remotionPlanPath = join(publicDir, 'plan.json')
    writeFileSync(remotionPlanPath, JSON.stringify(remotionPlan, null, 2), 'utf8')

    // 同时写一份带绝对路径的"停靠清单"，方便外部脚本直接消费
    writeFileSync(join(planDir, 'manifest.json'), JSON.stringify({
      job: job.id,
      planId: plan.id,
      plans: { host: hostPlanPath, remotion: remotionPlanPath },
      publicDir,
      shots: plan.shots.map(s => ({ id: s.id, from: s.from, frames: s.durationInFrames, assets: s.assets })),
      results: job.results,
      stats: job.stats,
    }, null, 2), 'utf8')

    return { hostPlanPath, remotionPlanPath }
  }

  /** 把 plan 里所有 /api/... 资产硬链接进 Remotion public，并改写成本地相对路径。 */
  private relocateAssets(plan: RenderPlan, publicDir: string): RenderPlan {
    const base = join(this.opts.pluginRoot, 'remotion', 'public')
    const cache = new Map<string, string>()
    const relocate = (url: string | undefined): string | undefined => {
      if (url === undefined || url === '') return url
      if (cache.has(url)) return cache.get(url)
      const fileKey = decodeURIComponent(url.split('/file/')[1] ?? '')
      if (fileKey === '') return url
      const [rootTag, ...rest] = fileKey.split('/')
      const rootDir = rootTag === 'c' ? this.opts.paths().cacheDir : this.opts.paths().outDir
      const abs = join(rootDir, ...rest)
      if (!existsSync(abs)) return url
      const target = join('forge', plan.id, rest.join('_'))
      const targetAbs = join(base, target)
      mkdirSync(dirname(targetAbs), { recursive: true })
      if (!existsSync(targetAbs)) {
        try {
          linkSync(abs, targetAbs)
        } catch {
          copyFileSync(abs, targetAbs)
        }
      }
      // Remotion 的 staticFile 只接受 POSIX 相对路径
      const out = target.split('\\').join('/')
      cache.set(url, out)
      return out
    }

    const rewriteShot = (shot: ShotPlan): ShotPlan => ({
      ...shot,
      assets: {
        still: relocate(shot.assets.still),
        plate: relocate(shot.assets.plate),
        depth: relocate(shot.assets.depth),
        matte: relocate(shot.assets.matte),
        normal: relocate(shot.assets.normal),
        video: relocate(shot.assets.video),
        transitionMask: relocate(shot.assets.transitionMask),
      },
      layer: shot.layer === undefined ? undefined : {
        ...shot.layer,
        src: relocate(shot.layer.src) ?? shot.layer.src,
        depthSrc: relocate(shot.layer.depthSrc),
        matteSrc: relocate(shot.layer.matteSrc),
      },
      video: shot.video === undefined ? undefined : { ...shot.video, src: relocate(shot.video.src) ?? shot.video.src },
      transitionIn: shot.transitionIn === undefined ? undefined : { ...shot.transitionIn, maskSrc: relocate(shot.transitionIn.maskSrc) },
      transitionOut: shot.transitionOut === undefined ? undefined : { ...shot.transitionOut, maskSrc: relocate(shot.transitionOut.maskSrc) },
    })

    return { ...plan, shots: plan.shots.map(rewriteShot) }
  }

  /** 健康快照 + 缓存统计，面板顶部状态栏用。 */
  async status(): Promise<Record<string, unknown>> {
    const [health, ffmpeg] = await Promise.all([
      this.registry.healthAll(),
      Promise.resolve(this.opts.config().ffmpegPath),
    ])
    const paths = this.opts.paths()
    return {
      ok: true,
      providers: health,
      capabilities: this.registry.capabilities(),
      cache: this.cache.stats(),
      jobs: this.listJobs(10),
      paths,
      clientId: this.clientId,
      ffmpeg: { path: ffmpeg, exists: ffmpeg !== '' && existsSync(ffmpeg) },
      comfyWorkflowDir: this.opts.config().workflowDir,
      comfyWorkflows: this.listWorkflows(),
    }
  }

  listWorkflows(): Array<{ name: string; path: string; bytes: number; modified: number }> {
    const dir = this.opts.config().workflowDir
    if (!existsSync(dir)) return []
    const out: Array<{ name: string; path: string; bytes: number; modified: number }> = []
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (extname(path).toLowerCase() !== '.json') continue
        try {
          const st = statSync(path)
          out.push({ name: relative(dir, path).split('\\').join('/'), path, bytes: st.size, modified: st.mtimeMs })
        } catch {
          /* skip */
        }
      }
    }
    walk(dir)
    return out.sort((a, b) => b.modified - a.modified)
  }

  readPlan(planId: string): RenderPlan | null {
    const path = join(this.opts.paths().plansDir, planId, 'plan.json')
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as RenderPlan
    } catch {
      return null
    }
  }

  listPlans(limit = 20): Array<{ planId: string; path: string; title: string; frames: number; shots: number; modified: number }> {
    const dir = this.opts.paths().plansDir
    if (!existsSync(dir)) return []
    const rows: Array<{ planId: string; path: string; title: string; frames: number; shots: number; modified: number }> = []
    for (const entry of readdirSync(dir) as string[]) {
      const path = join(dir, entry, 'plan.json')
      if (!existsSync(path)) continue
      try {
        const plan = JSON.parse(readFileSync(path, 'utf8')) as RenderPlan
        rows.push({ planId: plan.id, path, title: plan.title, frames: plan.durationInFrames, shots: plan.shots.length, modified: statSync(path).mtimeMs })
      } catch {
        /* skip */
      }
    }
    return rows.sort((a, b) => b.modified - a.modified).slice(0, limit)
  }

  /** 校验任意 plan 文件（面板「导入 plan」/CI 用）。 */
  checkPlan(plan: RenderPlan): PlanIssue[] {
    return validatePlan(plan)
  }

  resolveAssetPath(fileKey: string): string | null {
    const [rootTag, ...rest] = fileKey.split('/')
    if (rest.length === 0) return null
    const root = rootTag === 'c' ? this.opts.paths().cacheDir : rootTag === 'o' ? this.opts.paths().outDir : null
    if (root === null) return null
    const abs = join(root, ...rest)
    if (!isAbsolute(abs)) return null
    return existsSync(abs) ? abs : null
  }
}
