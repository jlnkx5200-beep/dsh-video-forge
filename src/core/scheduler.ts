/**
 * 统一任务调度器 —— 任务 DAG 编排 / 并发闸门 / 重试 / 降级 / 缓存。
 *
 * 设计取舍（写给未来的自己）：
 * 1) **不做静态拓扑排序一次性下发**：AI 任务耗时差异极大（图 20s、视频 5 分钟），
 *    静态分批会让先完成的分支空等。这里用"就绪即发、完成即放行下游"的滚动调度。
 * 2) **缓存键含上游指纹**：同一条 prompt 若上游首帧变了，命中上次的缓存是灾难，
 *    所以 fingerprint = sha256(自身参数 + 每个 dep 的指纹)。
 * 3) **降级显式化**：optional 任务失败 → 标 skipped 并继续；非 optional 失败才中断。
 *    fallback='mock' 时用占位产物顶替（面板会把这些镜头标黄），绝不静默换真实后端。
 */
import { createHash } from 'node:crypto'
import { canonicalJson, isAborted, sleep } from './http.js'
import { ForgeCache } from './cache.js'
import type {
  Artifact, CacheLike, ProviderConfig, ProviderId, RunContext, RunEvent, TaskRequest, TaskResult,
} from './providers/types.js'
import type { MediaProvider } from './providers/types.js'
import { ForgeError, isForgeError, isPendingQuota } from './providers/types.js'
import type { ProviderRegistry } from './providers/index.js'

export interface TaskNode {
  id: string
  provider: string
  kind: 'image' | 'video' | 'asset'
  params: Record<string, unknown>
  /** 上游引用：[{role:'first_frame', from:'shot-01-still'}] 由调度器解析成 path */
  needs?: Array<{ role: string; from: string }>
  deps?: string[]
  optional?: boolean
  fallback?: 'skip' | 'mock' | 'canvas'
  retries?: number
}

export interface SchedulerOptions {
  registry: Pick<ProviderRegistry, 'require' | 'has'>
  cache: ForgeCache | CacheLike
  config: () => ProviderConfig
  saveArtifact: (sub: string, fileName: string, bytes: Buffer, meta: Parameters<RunContext['save']>[3]) => Artifact
  tmpDir: string
  concurrency?: number
  /**
   * GPU 池并发（默认 1）：ComfyUI 只有一个实例、8GB 显存跑不了两路同时推理，
   * 但 API 侧的 Seedream / H3 完全可以并行 —— 分池才不会互相堵。
   */
  gpuConcurrency?: number
  mock?: boolean
  dryRun?: boolean
  /** 是否读写内容缓存（mock/dryRun 自动关闭） */
  useCache?: boolean
  onEvent?: (event: RunEvent) => void
  signal?: AbortSignal
}

export interface SchedulerStats {
  total: number
  ok: number
  failed: number
  skipped: number
  cached: number
  seconds: number
  providerCalls: Record<string, number>
}

export interface PendingQuotaInfo {
  taskId: string
  provider: string
  error: string
  /** 官方请求体快照（已脱敏，不含任何密钥）：配额下发后可原样重放 */
  requestSnapshot?: Record<string, unknown>
}

export interface SchedulerRunResult {
  order: string[]
  results: Map<string, TaskResult>
  stats: SchedulerStats
  /** 用户取消（AbortSignal）：剩余任务被标记 cancelled，上层据此把作业置为 cancelled */
  cancelled?: boolean
  /** 官方配额未下发（Sand.ai 400 insufficient_credits）：作业应标 pending_quota 并保留草稿 */
  pendingQuota?: PendingQuotaInfo
}

interface NodeState {
  node: TaskNode
  fingerprint?: string
  attempts: number
  done: boolean
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Provider 主动抛出的「已取消」（各 Provider 统一用 ForgeError code='cancelled'）。 */
function isCancelledError(error: unknown): boolean {
  if (isForgeError(error) && error.code === 'cancelled') return true
  const text = errText(error)
  return text === '已取消' || text === 'aborted' || text.includes('aborted')
}

function retryable(error: unknown): boolean {
  if (isForgeError(error)) return error.retryable
  const text = errText(error).toLowerCase()
  if (text.includes('429') || text.includes('rate limit') || text.includes('timeout') || text.includes('超时')) return true
  if (text.includes('econnrefused') || text.includes('econnreset') || text.includes('etimedout') || text.includes('fetch failed')) return true
  if (text.includes('5xx') || text.includes('http 50')) return true
  return false
}

export class Scheduler {
  private readonly concurrency: number
  private readonly gpuConcurrency: number
  /** provider → 资源池；GPU 池单实例串行，API 池按全局并发 */
  private static poolOf(provider: string): 'gpu' | 'api' {
    return provider === 'comfyui' ? 'gpu' : 'api'
  }

  constructor(private readonly opts: SchedulerOptions) {
    this.concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 3))
    this.gpuConcurrency = Math.max(1, Math.min(8, opts.gpuConcurrency ?? 1))
  }

  private emit(event: RunEvent): void {
    this.opts.onEvent?.(event)
  }

  /** DAG 合法性：dep 必须存在、不得成环。返回按就绪层次展开的顺序（仅用于展示）。 */
  static validate(tasks: TaskNode[]): string[] {
    const ids = new Set<string>()
    for (const task of tasks) {
      if (task.id.trim() === '') throw new Error('任务 id 不能为空')
      if (ids.has(task.id)) throw new Error('任务 id 重复：' + task.id)
      ids.add(task.id)
    }
    for (const task of tasks) {
      for (const dep of [...(task.deps ?? []), ...(task.needs ?? []).map(n => n.from)]) {
        if (!ids.has(dep)) throw new Error('任务 ' + task.id + ' 依赖了不存在的 ' + dep)
        if (dep === task.id) throw new Error('任务 ' + task.id + ' 不能依赖自己')
      }
    }
    // 拓扑（Kahn）—— 有环即报错
    const indegree = new Map<string, number>()
    const children = new Map<string, string[]>()
    for (const task of tasks) {
      indegree.set(task.id, 0)
      children.set(task.id, [])
    }
    for (const task of tasks) {
      for (const dep of new Set([...(task.deps ?? []), ...(task.needs ?? []).map(n => n.from)])) {
        indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1)
        children.get(dep)?.push(task.id)
      }
    }
    const queue: string[] = []
    for (const [id, degree] of indegree) if (degree === 0) queue.push(id)
    const order: string[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      order.push(id)
      for (const child of children.get(id) ?? []) {
        const next = (indegree.get(child) ?? 0) - 1
        indegree.set(child, next)
        if (next === 0) queue.push(child)
      }
    }
    if (order.length !== tasks.length) {
      const stuck = tasks.map(t => t.id).filter(id => !order.includes(id))
      throw new Error('任务 DAG 存在环：' + stuck.join(' → '))
    }
    return order
  }

  async run(tasks: TaskNode[]): Promise<SchedulerRunResult> {
    const startedAt = Date.now()
    const order = Scheduler.validate(tasks)
    const states = new Map<string, NodeState>()
    for (const node of tasks) states.set(node.id, { node, attempts: 0, done: false })

    const results = new Map<string, TaskResult>()
    const fingerprints = new Map<string, string>()
    const quotaFailures = new Map<string, PendingQuotaInfo>()
    let cancelled = false
    const stats: SchedulerStats = { total: tasks.length, ok: 0, failed: 0, skipped: 0, cached: 0, seconds: 0, providerCalls: {} }

    const depsOf = (node: TaskNode): string[] => [...new Set([...(node.deps ?? []), ...(node.needs ?? []).map(n => n.from)])]

    const settle = (node: TaskNode, result: TaskResult): void => {
      results.set(node.id, result)
      const state = states.get(node.id)
      if (state !== undefined) state.done = true
      if (result.ok) stats.ok += 1
      else if (result.warnings.includes('skipped') || (result.error ?? '').startsWith('skip')) stats.skipped += 1
      else stats.failed += 1
      if (result.cached) stats.cached += 1
    }

    const buildContext = (node: TaskNode): RunContext => ({
      emit: event => this.emit(event),
      cache: this.opts.cache,
      dryRun: this.opts.dryRun === true,
      mock: this.opts.mock === true,
      signal: this.opts.signal,
      log: message => this.emit({ type: 'log', taskId: node.id, provider: node.provider, at: Date.now(), message }),
      save: (sub, fileName, bytes, meta) => this.opts.saveArtifact(sub, fileName, bytes, meta),
      tmpDir: this.opts.tmpDir,
      config: this.opts.config(),
    })

    const resolveInputs = (node: TaskNode): Array<{ role: string; path?: string; artifactId?: string }> => {
      const inputs: Array<{ role: string; path?: string; artifactId?: string }> = []
      for (const need of node.needs ?? []) {
        const upstream = results.get(need.from)
        const artifact = upstream?.artifacts[0]
        if (artifact === undefined) {
          throw new ForgeError('上游 ' + need.from + ' 没有产物，无法作为 ' + need.role, false)
        }
        inputs.push({ role: need.role, path: artifact.path, artifactId: artifact.id })
      }
      return inputs
    }

    const fingerprintOf = (node: TaskNode, inputs: Array<{ role: string; path?: string; artifactId?: string }>, provider: MediaProvider): string => {
      const deps = depsOf(node).map(dep => (fingerprints.get(dep) ?? dep) as string)
      const request: TaskRequest = {
        id: node.id,
        provider: provider.id as ProviderId,
        kind: node.kind,
        params: node.params,
        inputs,
      }
      const base = this.opts.cache.fingerprint(request, { depsHash: createHash('sha256').update(canonicalJson(deps)).digest('hex') })
      return base
    }

    const runOne = async (node: TaskNode): Promise<void> => {
      const state = states.get(node.id)!
      const useMock = this.opts.mock === true
      const provider = useMock ? this.opts.registry.require('mock') : this.opts.registry.require(node.provider)
      // dry-run：上游只算了指纹、没有真实产物 —— 本任务同样只做「将会调用」的记录，
      // 不把整条链判成失败（否则一次 dryRun 会看到下游全红，误以为 DAG 编排有问题）。
      const dryUpstream = (node.needs ?? []).find(need => results.get(need.from)?.wouldCall !== undefined)
      if (dryUpstream !== undefined) {
        this.emit({ type: 'skip', taskId: node.id, provider: provider.id, at: Date.now(), message: 'dry-run：上游未真正产出' })
        settle(node, {
          ok: true, taskId: node.id, provider: provider.id as ProviderId, artifacts: [], seconds: 0,
          cached: false, wouldCall: { taskId: node.id, provider: provider.id, kind: node.kind, note: 'dry-run：上游未真正产出' },
          warnings: ['dry-run：上游 ' + dryUpstream.from + ' 未真正产出，本任务仅登记指纹'],
        })
        return
      }

      let inputs: Array<{ role: string; path?: string; artifactId?: string }> = []
      try {
        inputs = resolveInputs(node)
      } catch (error) {
        settle(node, {
          ok: false, taskId: node.id, provider: provider.id, artifacts: [], seconds: 0, cached: false,
          warnings: [], error: errText(error),
        })
        return
      }

      const fingerprint = fingerprintOf(node, inputs, provider)
      fingerprints.set(node.id, fingerprint)
      state.fingerprint = fingerprint
      const cacheEnabled = this.opts.useCache !== false && useMock === false && this.opts.dryRun !== true

      if (cacheEnabled) {
        const hit = this.opts.cache.read(fingerprint)
        if (hit !== null) {
          const artifacts = this.opts.cache.artifacts(hit)
          this.emit({ type: 'cache', taskId: node.id, provider: provider.id, at: Date.now(), message: '缓存命中 ' + fingerprint.slice(0, 8) })
          settle(node, {
            ok: true, taskId: node.id, provider: provider.id as ProviderId, artifacts,
            seconds: 0, cached: true, warnings: ['缓存命中，未发起真实调用'],
            usage: { fingerprint },
          })
          return
        }
      }

      this.emit({ type: 'queued', taskId: node.id, provider: provider.id, at: Date.now() })
      const request: TaskRequest = {
        id: node.id,
        provider: provider.id as ProviderId,
        kind: node.kind,
        params: node.params,
        inputs,
        deps: depsOf(node),
        optional: node.optional,
        fallback: node.fallback,
      }
      const maxAttempts = Math.max(1, Math.min(4, (node.retries ?? 2) + 1))
      let lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isAborted(this.opts.signal)) {
          settle(node, {
            ok: false, taskId: node.id, provider: provider.id as ProviderId, artifacts: [], seconds: 0, cached: false,
            warnings: ['cancelled'], error: 'cancelled: 已取消',
          })
          return
        }
        state.attempts = attempt
        try {
          const result = await provider.run(request, buildContext(node))
          stats.providerCalls[provider.id] = (stats.providerCalls[provider.id] ?? 0) + 1
          if (cacheEnabled && result.ok && result.artifacts.length > 0) {
            this.opts.cache.write(fingerprint, result, result.artifacts.map(a => ({ path: a.path, name: a.path.split(/[\\/]/).pop() ?? a.id })))
          }
          this.emit({ type: 'done', taskId: node.id, provider: provider.id, at: Date.now(), message: result.artifacts.length + ' 个产物', data: { fingerprint, cached: false } })
          settle(node, result)
          return
        } catch (error) {
          lastError = error
          // 取消不是失败：立刻收尾成 cancelled，绝不重试、绝不降级成 mock。
          if (isAborted(this.opts.signal) || isCancelledError(error)) {
            cancelled = true
            settle(node, {
              ok: false, taskId: node.id, provider: provider.id as ProviderId, artifacts: [], seconds: 0,
              cached: false, warnings: ['cancelled'], error: 'cancelled: 已取消',
            })
            return
          }
          // 配额未下发不是失败：不重试、不降级、不覆盖草稿，直接上报给上层做 pending_quota。
          if (isPendingQuota(error)) {
            const detail = isForgeError(error) ? error.detail ?? {} : {}
            quotaFailures.set(node.id, {
              taskId: node.id,
              provider: provider.id,
              error: errText(error),
              requestSnapshot: detail['requestSnapshot'] as Record<string, unknown> | undefined,
            })
            this.emit({ type: 'error', taskId: node.id, provider: provider.id, at: Date.now(), message: 'pending_quota：' + errText(error) })
            break
          }
          const canRetry = attempt < maxAttempts && retryable(error)
          this.emit({
            type: 'error', taskId: node.id, provider: provider.id, at: Date.now(),
            message: '第 ' + attempt + '/' + maxAttempts + ' 次失败：' + errText(error) + (canRetry ? '（将重试）' : ''),
          })
          if (!canRetry) break
          try {
            // 可取消的重试等待：取消时立刻从 sleep 抛出，不再空转 15s。
            await sleep(Math.min(15000, 800 * attempt * attempt), this.opts.signal)
          } catch {
            cancelled = true
            break
          }
        }
      }

      const quota = quotaFailures.get(node.id)
      if (quota !== undefined) {
        // 无草稿可用时也不能把"待配额"当普通失败：保留错误原文，作业状态由上层改写。
        settle(node, {
          ok: false, taskId: node.id, provider: provider.id as ProviderId, artifacts: [], seconds: 0, cached: false,
          warnings: ['pending_quota'], error: 'pending_quota: ' + quota.error,
          usage: { pendingQuota: true },
        })
        return
      }

      // 降级
      const degraded = node.fallback === 'mock' ? true : node.optional === true || node.fallback === 'skip'
      if (node.fallback === 'mock') {
        try {
          const mockProvider = this.opts.registry.require('mock')
          const result = await mockProvider.run(request, buildContext(node))
          settle(node, { ...result, warnings: [...result.warnings, '真实 Provider 失败，已降级为 mock 占位产物'], error: errText(lastError) })
          return
        } catch {
          /* mock 也失败 → 走 skip 分支 */
        }
      }
      if (degraded) {
        this.emit({ type: 'skip', taskId: node.id, provider: provider.id, at: Date.now(), message: '跳过：' + errText(lastError) })
        settle(node, {
          ok: false, taskId: node.id, provider: provider.id as ProviderId, artifacts: [], seconds: 0, cached: false,
          warnings: ['skipped', '下游会缺这一份资产：' + errText(lastError)], error: 'skipped: ' + errText(lastError),
        })
        return
      }
      settle(node, {
        ok: false, taskId: node.id, provider: provider.id as ProviderId, artifacts: [], seconds: 0, cached: false,
        warnings: [], error: errText(lastError),
      })
    }

    // 滚动调度：就绪队列 + 并发闸门
    const pending = new Set(tasks.map(t => t.id))
    const running = new Set<Promise<void>>()
    const failures = new Set<string>()
    // 分池计数：GPU（ComfyUI）与 API（Seedream / H3 / Sand.ai）各自排队
    const poolBusy = { gpu: 0, api: 0 } as Record<'gpu' | 'api', number>
    const poolLimit = (pool: 'gpu' | 'api'): number => (pool === 'gpu' ? this.gpuConcurrency : this.concurrency)

    const ready = (node: TaskNode): boolean => depsOf(node).every(dep => states.get(dep)?.done === true)
    const blockedByFailure = (node: TaskNode): boolean => depsOf(node).some(dep => failures.has(dep))

    while (pending.size > 0 || running.size > 0) {
      if (isAborted(this.opts.signal)) {
        cancelled = true
        this.emit({ type: 'error', taskId: '*', provider: '*', at: Date.now(), message: '已取消' })
        for (const id of [...pending]) {
          const state = states.get(id)
          if (state === undefined) continue
          pending.delete(id)
          settle(state.node, {
            ok: false, taskId: id, provider: state.node.provider as ProviderId, artifacts: [], seconds: 0,
            cached: false, warnings: ['cancelled'], error: 'cancelled: 已取消（排队中被中止）',
          })
          this.emit({ type: 'error', taskId: id, provider: state.node.provider, at: Date.now(), message: '已取消（未开始）' })
        }
        break
      }
      let launched = false
      for (const id of [...pending]) {
        if (running.size >= this.concurrency) break
        const state = states.get(id)!
        const node = state.node
        if (!ready(node)) continue
        const pool = Scheduler.poolOf(node.provider)
        if (poolBusy[pool] >= poolLimit(pool)) continue
        pending.delete(id)
        if (blockedByFailure(node)) {
          failures.add(id)
          this.emit({ type: 'skip', taskId: id, provider: node.provider, at: Date.now(), message: '上游失败，跳过' })
          settle(node, {
            ok: false, taskId: id, provider: node.provider as ProviderId, artifacts: [], seconds: 0, cached: false,
            warnings: ['skipped', '上游失败'], error: 'skipped: 上游失败',
          })
          launched = true
          continue
        }
        const promise = runOne(node)
          .catch(error => {
            settle(node, {
              ok: false, taskId: id, provider: node.provider as ProviderId, artifacts: [], seconds: 0, cached: false,
              warnings: [], error: errText(error),
            })
          })
          .then(() => {
            const result = results.get(id)
            if (result !== undefined && !result.ok && !(result.error ?? '').startsWith('skipped')) failures.add(id)
          })
          .finally(() => {
            running.delete(promise)
            poolBusy[pool] = Math.max(0, poolBusy[pool] - 1)
          })
        poolBusy[pool] += 1
        running.add(promise)
        launched = true
      }
      if (running.size > 0) {
        await Promise.race(running)
        continue
      }
      if (!launched) {
        // 没有可启动的、也没有在跑的 → 剩余任务全部卡死（理论上 validate 已挡住环）
        for (const id of pending) {
          settle(states.get(id)!.node, {
            ok: false, taskId: id, provider: states.get(id)!.node.provider as ProviderId, artifacts: [], seconds: 0,
            cached: false, warnings: [], error: 'DAG 无法继续（依赖未完成）',
          })
        }
        pending.clear()
      }
    }

    stats.seconds = Math.round((Date.now() - startedAt) / 100) / 10
    const quota = quotaFailures.values().next()
    return {
      order,
      results,
      stats,
      ...(cancelled || isAborted(this.opts.signal) ? { cancelled: true } : {}),
      ...(quota.done === true ? {} : { pendingQuota: quota.value as PendingQuotaInfo }),
    }
  }
}
