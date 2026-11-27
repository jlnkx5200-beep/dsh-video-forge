/**
 * Video Forge —— 风格无关的 AI 视频生产线（Seedream + MiniMax H3 + ComfyUI → Three.js → Remotion）
 *
 * host 侧只做四件事：
 *   1. 把三个外部能力抽象成统一异步任务 Provider（core/providers）
 *   2. 把分镜编译成任务 DAG 并调度（bridge/compiler + core/scheduler）
 *   3. 产出 RenderPlan（跨进程唯一契约）并同步资产到 remotion/public
 *   4. 给 Agent 工具 + 给面板 HTTP 路由
 *
 * 不出现任何具体艺术风格、镜头语言或 three 概念 —— 这些都在 remotion/ 子工程里。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { clampMagi2Duration, keyHint, readLegacySeedreamKey, readUserConfig, resolveKey, writeUserConfig, ensureDirs, dshHome, type ForgePaths, type ForgeUserConfig, type KeySource } from './core/config.js'
import type { Magi2Provider } from './core/providers/magi2.js'
import { ForgeRuntime, type JobRecord } from './core/runtime.js'
import type { MediaKind, ProviderConfig, ProviderId, TaskResult } from './core/providers/types.js'
import type { CompileOptions, StoryboardInput } from './bridge/compiler.js'
import { listStylePrompts, DEFAULT_STYLE_ID } from './bridge/style-prompts.js'
import type { RenderPlan } from './bridge/render-plan.js'
import { readFileDirect, readJsonBody, writeJson, isLocalRequest } from './core/http.js'
import { lossless } from './core/json.js'
import { hashSeed } from './core/png.js'
import { parseStoryboardTable } from './bridge/compiler.js'

export const name = '@dsh-external/dsh-video-forge'

/** 需要 tools（注册工具）与 webServer（面板路由）。 */
export const inject = ['tools', 'webServer']

export interface Config {
  /** 方舟 baseUrl，默认北京区 */
  arkBaseUrl?: string
  /** 方舟 API Key（留空则读 ~/.dsh/video-forge.json 或 ARK_API_KEY） */
  arkApiKey?: string
  /** 默认 Seedream 模型别名 */
  defaultSeedreamModel?: string
  /** MiniMax baseUrl：国内站 api.minimaxi.com / 国际站 api.minimax.io */
  minimaxBaseUrl?: string
  /** MiniMax API Key（留空则读 ~/.dsh/video-forge.json 或 MINIMAX_API_KEY） */
  minimaxApiKey?: string
  /** 默认 MiniMax 模型 */
  defaultMinimaxModel?: string
  /** 默认分辨率 480P/768P/2K */
  minimaxResolution?: string
  /** 本地 ComfyUI 地址 */
  comfyBaseUrl?: string
  /** ComfyUI workflow JSON 目录 */
  workflowDir?: string
  /** 产物根目录（out/cache/plans/tmp 建在其下） */
  dataDir?: string
  /** 面板 → ComfyUI 桥接令牌（自定义节点回连宿主时用） */
  bridgeToken?: string
  /** ffmpeg 可执行文件（mock 视频合成用） */
  ffmpegPath?: string
  /** 单次生产的最大并发任务数 */
  maxConcurrent?: number
  /** Sand.ai 官方 baseUrl（MAGI-2 直连，不走任何第三方网关） */
  sandBaseUrl?: string
  /** Sand.ai API Key（留空则读 ~/.dsh/video-forge.json 或 SAND_API_KEY） */
  sandApiKey?: string
  /** MAGI-2 默认时长（4–30 整数秒） */
  defaultMagi2Duration?: number
  /** MAGI-2 默认模型 */
  defaultMagi2Model?: string
}

export const Config = z.object({
  arkBaseUrl: z.string().default('https://ark.cn-beijing.volces.com/api/v3'),
  arkApiKey: z.string().default(''),
  defaultSeedreamModel: z.string().default('5.0-flash'),
  minimaxBaseUrl: z.string().default('https://api.minimaxi.com'),
  minimaxApiKey: z.string().default(''),
  defaultMinimaxModel: z.string().default('MiniMax-H3'),
  minimaxResolution: z.string().default('768P'),
  comfyBaseUrl: z.string().default('http://127.0.0.1:8188'),
  workflowDir: z.string().default(''),
  dataDir: z.string().default(''),
  bridgeToken: z.string().default(''),
  ffmpegPath: z.string().default(''),
  maxConcurrent: z.number().min(1).max(8).default(3),
  sandBaseUrl: z.string().default('https://api.sand.ai'),
  sandApiKey: z.string().default(''),
  defaultMagi2Duration: z.number().min(4).max(30).default(8),
  defaultMagi2Model: z.string().default('MAGI-2'),
})

function pluginRoot(): string {
  // lib/index.js → 插件根目录
  const here = dirname(fileURLToPath(import.meta.url))
  return resolvePath(here, '..')
}

function defaultFfmpeg(): string {
  const workspace = resolvePath(pluginRoot(), '..', '..')
  const candidates = [
    process.env.FFMPEG_PATH ?? '',
    join(workspace, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    join(workspace, 'tools', 'ffmpeg', 'ffmpeg.exe'),
  ]
  // 本工作区把 ffmpeg 解在 `tools/ffmpeg/ffmpeg-<ver>-essentials_build/bin/` 下，
  // 版本号会变，所以再扫一层目录找 ffmpeg.exe。
  const ffmpegHome = join(workspace, 'tools', 'ffmpeg')
  if (existsSync(ffmpegHome)) {
    try {
      for (const entry of readdirSync(ffmpegHome)) {
        candidates.push(join(ffmpegHome, entry, 'bin', 'ffmpeg.exe'))
        candidates.push(join(ffmpegHome, entry, 'ffmpeg.exe'))
      }
    } catch {
      /* 目录不可读就跳过 */
    }
  }
  for (const candidate of candidates) {
    if (candidate === '') continue
    if (existsSync(candidate)) return candidate
  }
  // 最后的兜底：交给 PATH（注意必须放在所有绝对候选之后，否则会提前命中）
  return 'ffmpeg'
}

function defaultWorkflowDir(): string {
  const candidates = [join(pluginRoot(), 'workflows'), join(pluginRoot(), '..', '..', 'workflows')]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return join(pluginRoot(), 'workflows')
}

function statusOf(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    planId: job.planId,
    title: job.title,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    mock: job.mock,
    dryRun: job.dryRun,
    progress: job.progress,
    issues: job.issues,
    results: job.results,
    stats: job.stats,
    error: job.error,
    planPath: job.planPath,
    planJsonPath: job.planJsonPath,
    /** 完整提交快照（脱敏）：P0-1「按原参数重跑」的唯一依据 */
    requestSnapshot: job.requestSnapshot,
    /** 待官方配额时携带原因，前端据此显示"已鉴权·等配额"而不是红色失败 */
    pendingQuota: job.pendingQuota,
    cancelable: job.status === 'running',
    eventCount: job.events.length,
  }
}

export function apply(ctx: Context & { webServer: { register(route: unknown): () => void } }, config: Config): void {
  const root = pluginRoot()

  const dataDir = (): string => config.dataDir !== '' && config.dataDir !== undefined ? config.dataDir : join(dshHome(), 'video-forge')
  let paths: ForgePaths = ensureDirs(dataDir())
  const pathsFn = (): ForgePaths => {
    paths = ensureDirs(dataDir())
    return paths
  }
  pathsFn()

  /**
   * Ark Key 解析：插件 config → video-forge.json → ARK_API_KEY → 既有 seedream 插件的
   * `~/.dsh/seedream.json`（只读回退，避免同一把 Key 存两处）。
   */
  function arkChain(): { key: string; source: KeySource } {
    const user = readUserConfig()
    const resolved = resolveKey({ configKey: config.arkApiKey ?? '', userKey: user.arkApiKey ?? '', envName: 'ARK_API_KEY' })
    if (resolved.key !== '') return resolved
    const legacy = readLegacySeedreamKey()
    return legacy !== '' ? { key: legacy, source: 'seedream-plugin' } : { key: '', source: 'none' }
  }

  function providerConfig(): ProviderConfig {
    const user = readUserConfig()
    const ark = arkChain()
    const minimax = resolveKey({ configKey: config.minimaxApiKey ?? '', userKey: user.minimaxApiKey ?? '', envName: 'MINIMAX_API_KEY' })
    const bridge = resolveKey({ configKey: config.bridgeToken ?? '', userKey: user.bridgeToken ?? '', envName: 'DSH_FORGE_BRIDGE_TOKEN' })
    const sand = resolveKey({ configKey: config.sandApiKey ?? '', userKey: user.sandApiKey ?? '', envName: 'SAND_API_KEY' })
    return {
      arkBaseUrl: (config.arkBaseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, ''),
      arkApiKey: ark.key,
      defaultSeedreamModel: config.defaultSeedreamModel ?? '5.0-flash',
      minimaxBaseUrl: (user.minimaxBaseUrl || config.minimaxBaseUrl || 'https://api.minimaxi.com').replace(/\/+$/, ''),
      minimaxApiKey: minimax.key,
      defaultMinimaxModel: config.defaultMinimaxModel ?? 'MiniMax-H3',
      minimaxResolution: config.minimaxResolution ?? '768P',
      comfyBaseUrl: (user.comfyBaseUrl || config.comfyBaseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
      workflowDir: config.workflowDir !== '' && config.workflowDir !== undefined ? config.workflowDir : defaultWorkflowDir(),
      outputDir: pathsFn().outDir,
      bridgeToken: bridge.key,
      ffmpegPath: config.ffmpegPath !== '' && config.ffmpegPath !== undefined ? config.ffmpegPath : defaultFfmpeg(),
      // Sand.ai 官方直连：不引入任何第三方聚合网关
      sandBaseUrl: (user.sandBaseUrl || config.sandBaseUrl || 'https://api.sand.ai').replace(/\/+$/, ''),
      sandApiKey: sand.key,
      defaultMagi2Duration: clampMagi2Duration(user.defaultMagi2Duration ?? config.defaultMagi2Duration ?? 8),
    }
  }

  /** Sand.ai Key 解析链：插件 config → video-forge.json → SAND_API_KEY。 */
  function sandChain(): { key: string; source: KeySource } {
    const user = readUserConfig()
    return resolveKey({ configKey: config.sandApiKey ?? '', userKey: user.sandApiKey ?? '', envName: 'SAND_API_KEY' })
  }

  const runtime = new ForgeRuntime({
    config: providerConfig,
    paths: pathsFn,
    pluginRoot: root,
    eventBuffer: 400,
  })

  /** MAGI-2 Key 状态（内存缓存：missing_key / invalid_key / pending_quota / ready / configured_unprobed）。 */
  function magi2State(): Record<string, unknown> {
    const provider = runtime.providers.get('magi2') as unknown as { keyState?: () => { state: string; detail: string; at?: number } } | undefined
    const state = provider?.keyState?.() ?? { state: 'missing_key', detail: 'MAGI-2 Provider 未注册' }
    return {
      state: state.state,
      detail: state.detail,
      probedAt: state.at,
      baseUrl: providerConfig().sandBaseUrl,
      keyHint: keyHint(sandChain().key),
      keySource: sandChain().source,
      defaultDuration: providerConfig().defaultMagi2Duration,
    }
  }

  // ── 工具 1：健康与能力 ─────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'video_forge_status',
    description: 'Video Forge 健康检查：Seedream / MiniMax H3 / 本地 ComfyUI 连接状态、显存内存、缓存统计、可用 workflow 列表。生产前先跑一次。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => {
        const v = value as { providers: Array<{ provider: string; status: string; detail: string }>; cache: { entries: number; bytes: number }; comfyWorkflows: Array<{ name: string }>; ffmpeg?: { path: string; exists: boolean }; comfyWorkflowDir?: string; paths?: { home: string; plansDir: string } }
        const lines = ['Video Forge 状态：']
        for (const p of v.providers) lines.push('· ' + p.provider + ' — ' + p.status + '（' + p.detail + '）')
        lines.push('· 缓存 ' + v.cache.entries + ' 条 / ' + Math.round(v.cache.bytes / 1048576) + ' MB')
        lines.push('· ffmpeg：' + (v.ffmpeg?.exists === true ? v.ffmpeg.path : '未找到（mock 视频会退化为静帧；可设 FFMPEG_PATH）'))
        if (v.comfyWorkflowDir !== undefined) lines.push('· workflowDir：' + v.comfyWorkflowDir)
        if (v.paths !== undefined) lines.push('· 数据目录：' + v.paths.home + '（plan 在 plans/）')
        if (v.comfyWorkflows.length > 0) lines.push('· 可用 workflow：' + v.comfyWorkflows.slice(0, 8).map(w => w.name).join(', '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      return lossless(await runtime.status()) as never
    },
  })), '@dsh-external/dsh-video-forge: status tool')

  // ── 工具 2：跑一次生产（storyboard → RenderPlan） ──────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'video_forge_produce',
    description: '把 video-shotcraft 分镜交给 Video Forge 生产：可传 shots（结构化分镜数组）或 markdownTable（| # | 时间 | 镜头 | 关键动效 | 表）。自动编排 Seedream 静帧 → ComfyUI 深度/抠图 → MiniMax H3 视频 → 写 RenderPlan 到 remotion/public。mock=true 时零成本跑通全链路。',
    parameters: {
      title: { type: 'string', description: '片子标题' },
      shots: { type: 'json', description: '结构化分镜数组：[{id,shot,durationSec,prompt,move,transition,strategy,referenceImages,referenceVideos,referenceAudios,firstFrame,lastFrame,generateAudio,timelineCues,...}]' },
      markdownTable: { type: 'string', description: 'video-shotcraft 的分镜表 markdown（与 shots 二选一）' },
      preset: { type: 'string', description: `风格预设：${listStylePrompts().map(item => item.id).join(' | ')}（默认 ${DEFAULT_STYLE_ID}）` },
      width: { type: 'integer', description: '画宽，默认 1920' },
      height: { type: 'integer', description: '画高，默认 1080' },
      fps: { type: 'integer', description: '帧率，默认 30' },
      styleTags: { type: 'string', description: '风格标签，逗号分隔（透传给 Remotion 侧 shader/preset 选择）' },
      defaultStrategy: { type: 'string', description: 'seedream-static | still-3d | minimax-direct | minimax-2k-repaint | comfy-pipeline | magi2-direct | magi2-i2v，默认 seedream-static' },
      seedreamModel: { type: 'string', description: 'Seedream 模型别名，默认 5.0-flash' },
      minimaxModel: { type: 'string', description: 'MiniMax 模型，默认 MiniMax-H3' },
      minimaxResolution: { type: 'string', description: '480P | 768P | 2K，默认 768P' },
      magi2Model: { type: 'string', description: 'MAGI-2 模型，默认 MAGI-2（Sand.ai 官方直连）' },
      magi2Duration: { type: 'integer', description: 'MAGI-2 单镜时长 4–30 秒（缺省按分镜时长）' },
      generateAudio: { type: 'boolean', description: 'MAGI-2 是否生成音轨（false 时产物无音轨，meta.hasAudio=false）' },
      depthWorkflow: { type: 'string', description: 'ComfyUI 深度估计 workflow 名（相对 workflowDir）' },
      matteWorkflow: { type: 'string', description: 'ComfyUI 抠图 workflow 名（production 建议 dsh-matte-v2.api.json = BiRefNet 真抠像）' },
      plateWorkflow: { type: 'string', description: 'ComfyUI 背景板 workflow 名（默认 dsh-plate.api.json；production 下有 matte 会自动加这一步）' },
      qualityMode: { type: 'string', description: 'production（默认，画质红线生效）| draft（快速试排，允许伪算法与 480P）' },
      enablePlate: { type: 'boolean', description: '是否启用背景板剥离（主角清晰的产品/人物镜头才需要；风景默认关闭）' },
      mock: { type: 'boolean', description: '全部走 mock provider（零成本、可离线）' },
      dryRun: { type: 'boolean', description: '只算指纹与预估，不真正调用' },
      useCache: { type: 'boolean', description: '是否用内容寻址缓存，默认 true' },
      writePlan: { type: 'boolean', description: '是否落盘 RenderPlan，默认 true' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => {
        const v = value as { ok: boolean; job: Record<string, unknown> }
        const job = v.job as { id: string; status: string; planId: string; planPath?: string; error?: string; stats?: Record<string, unknown>; results: Array<{ id: string; ok: boolean; cached: boolean; seconds: number; artifacts: number; error?: string }> }
        const lines = ['video_forge_produce → ' + job.status + '（' + job.id + '）', 'planId：' + job.planId]
        if (job.planPath !== undefined) lines.push('RenderPlan：' + job.planPath)
        for (const r of job.results) lines.push('· ' + r.id + ' — ' + (r.ok ? 'ok' : 'failed') + (r.cached ? '（缓存）' : '') + ' ' + r.seconds.toFixed(1) + 's / ' + r.artifacts + ' 产物' + (r.error === undefined ? '' : ' — ' + r.error))
        if (job.stats !== undefined) lines.push('stats：' + JSON.stringify(job.stats))
        if (job.error !== undefined) lines.push('error：' + job.error)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: any) {
      const input = args as Record<string, unknown>
      const storyboard = buildStoryboard(input)
      const job = await runtime.produce(storyboard, {
        defaultStrategy: strategyOf(input.defaultStrategy),
        seedreamModel: typeof input.seedreamModel === 'string' ? input.seedreamModel : undefined,
        minimaxModel: typeof input.minimaxModel === 'string' ? input.minimaxModel : undefined,
        minimaxResolution: typeof input.minimaxResolution === 'string' ? input.minimaxResolution : undefined,
        magi2Model: typeof input.magi2Model === 'string' ? input.magi2Model : (config.defaultMagi2Model ?? 'MAGI-2'),
        magi2Duration: Number.isFinite(Number(input.magi2Duration)) ? Number(input.magi2Duration) : undefined,
        generateAudio: typeof input.generateAudio === 'boolean' ? input.generateAudio : undefined,
        depthWorkflow: typeof input.depthWorkflow === 'string' ? input.depthWorkflow : undefined,
        matteWorkflow: typeof input.matteWorkflow === 'string' ? input.matteWorkflow : undefined,
        plateWorkflow: typeof input.plateWorkflow === 'string' ? input.plateWorkflow : undefined,
        qualityMode: qualityModeOf(input.qualityMode),
        enablePlate: input.enablePlate === true,
        preset: typeof input.preset === 'string' ? input.preset : undefined,
        mock: input.mock === true,
        dryRun: input.dryRun === true,
        useCache: input.useCache !== false,
        writePlan: input.writePlan !== false,
        concurrency: config.maxConcurrent ?? 3,
      })
      return lossless({ ok: job.status === 'done', job: statusOf(job) }) as never
    },
  })), '@dsh-external/dsh-video-forge: produce tool')

  // ── 工具 3：直接跑一段 ComfyUI workflow ────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'video_forge_comfy_run',
    description: '直接执行一个 ComfyUI API 格式 workflow（支持 ${a.b.c} / ${VAR:fallback} 占位符注入），返回产物路径。用于验证自定义节点或临时加工。',
    parameters: {
      workflow: { type: 'json', description: 'API 格式 workflow JSON（与 workflowName 二选一）' },
      workflowName: { type: 'string', description: 'workflowDir 下的文件名' },
      placeholders: { type: 'json', description: '占位符作用域对象，如 {"asset":{"source":"x.png"}}' },
      inputs: { type: 'json', description: '要上传的本地文件：[{role,path}]' },
      mock: { type: 'boolean', description: '跳过真实执行，只做参数注入检查' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => {
        const v = value as { ok: boolean; artifacts?: Array<{ path: string }>; error?: string }
        if (!v.ok) return [{ type: 'text', text: 'ComfyUI 执行失败：' + (v.error ?? '未知错误') }]
        return [{ type: 'text', text: 'ComfyUI 执行完成：\n' + (v.artifacts ?? []).map(a => '· ' + a.path).join('\n') }]
      },
    },
    async execute(args: any) {
      const input = args as Record<string, unknown>
      const provider = runtime.providers.require('comfyui')
      const ctxLike = {
        emit: () => { /* 工具内静默 */ },
        cache: runtime.cacheStore,
        dryRun: input.mock === true,
        mock: input.mock === true,
        signal: new AbortController().signal,
        log: () => { /* 静默 */ },
        save: (sub: string, fileName: string, bytes: Buffer, meta?: Record<string, unknown>) => runtime.saveArtifact(sub, fileName, bytes, meta as never),
        tmpDir: pathsFn().tmpDir,
        config: providerConfig(),
      }
      const result = await provider.run({
        id: 'comfy-tool',
        provider: 'comfyui',
        kind: 'asset',
        params: {
          workflow: input.workflow,
          workflowName: input.workflowName,
          context: input.placeholders ?? {},
        },
        inputs: Array.isArray(input.inputs) ? input.inputs as never : [],
        deps: [],
      }, ctxLike as never)
      return lossless({ ok: result.ok, artifacts: result.artifacts.map(a => ({ path: a.path, url: a.url })), error: result.error }) as never
    },
  })), '@dsh-external/dsh-video-forge: comfy run tool')

  /**
   * 桥接端点用的同步执行器：与工具里那份 RunContext 同构，
   * 但不带事件回调（HTTP 请求里没有订阅者），dry-run 由 params.dryRun 控制。
   */
  const bridgeRun = async (
    providerId: ProviderId,
    kind: MediaKind,
    params: Record<string, unknown>,
    inputs: unknown[],
  ): Promise<TaskResult> => {
    const provider = runtime.providers.require(providerId)
    return provider.run({
      id: 'bridge-' + providerId,
      provider: providerId,
      kind,
      params,
      inputs: inputs as never,
      deps: [],
    }, {
      emit: () => { /* 桥接调用无订阅者 */ },
      cache: runtime.cacheStore,
      dryRun: params.dryRun === true,
      mock: false,
      signal: new AbortController().signal,
      log: () => { /* 静默 */ },
      save: (sub: string, fileName: string, bytes: Buffer, meta?: Record<string, unknown>) => runtime.saveArtifact(sub, fileName, bytes, meta as never),
      tmpDir: pathsFn().tmpDir,
      config: providerConfig(),
    } as never)
  }

  // ── HTTP 路由：给 Web 面板 ────────────────────────────────────────────
  const PREFIX = '/api/dsh-video-forge'
  const route = {
    kind: 'prefix' as const,
    path: PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        if (!isLocalRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname.replace(/\/+$/, '')
        const rest = path.slice(PREFIX.length)

        // GET /status
        if (rest === '/status' && req.method === 'GET') {
          const status = await runtime.status()
          writeJson(res, 200, {
            ...status,
            keys: {
              ark: { present: providerConfig().arkApiKey !== '', hint: keyHint(providerConfig().arkApiKey), source: arkChain().source },
              minimax: { present: providerConfig().minimaxApiKey !== '', hint: keyHint(providerConfig().minimaxApiKey), source: resolveKey({ configKey: config.minimaxApiKey ?? '', userKey: readUserConfig().minimaxApiKey ?? '', envName: 'MINIMAX_API_KEY' }).source },
              sand: { present: sandChain().key !== '', hint: keyHint(sandChain().key), source: sandChain().source },
            },
            magi2: magi2State(),
            fetchedAt: Date.now(),
            userConfigPath: join(dshHome(), 'video-forge.json'),
            configOk: true,
          })
          return
        }

        // POST /magi2/probe —— 手动探针（只发免计费 GET；默认绝不自动探测，避免将来有配额时误扣费）
        if (rest === '/magi2/probe' && req.method === 'POST') {
          const provider = runtime.providers.get('magi2') as unknown as Magi2Provider | undefined
          if (provider === undefined) {
            writeJson(res, 503, { ok: false, error: 'MAGI-2 Provider 未注册' })
            return
          }
          const probe = await provider.probe()
          writeJson(res, 200, {
            ok: probe.state !== 'invalid_key' && probe.state !== 'missing_key',
            probe,
            hint: probe.state === 'pending_quota'
              ? '鉴权通过、配额不可用（400 insufficient_credits）：无需改代码，配额下发后直接生成或一键重放'
              : probe.state === 'ready'
                // 免费 GET 只能证明 Key 有效；官方没有免计费的余额查询，别把 200 说成「有配额」。
                ? '鉴权通过（待首次生成确认配额）：探针只打免费接口，不查余额；首次生成若返回 400 insufficient_credits 会自动转为 pending_quota'
                : probe.state === 'missing_key'
                  ? '请先在「设置 → Sand.ai」填入 SAND_API_KEY'
                  : probe.detail,
          })
          return
        }

        // POST /config —— 写入 ~/.dsh/video-forge.json（只收白名单字段）
        if (rest === '/config' && req.method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          // 白名单：只有这里列出的字段能写进 ~/.dsh/video-forge.json（绝不接受任意键）
          const STRING_KEYS = [
            'arkApiKey', 'arkBaseUrl', 'defaultSeedreamModel',
            'minimaxApiKey', 'minimaxBaseUrl', 'minimaxModel', 'minimaxResolution',
            'sandApiKey', 'sandBaseUrl',
            'comfyBaseUrl', 'workflowDir', 'dataDir', 'bridgeToken', 'ffmpegPath',
          ] as const
          const patch: ForgeUserConfig = {}
          const rejected: string[] = []
          for (const [key, value] of Object.entries(body)) {
            if (key === 'defaultMagi2Duration') {
              if (typeof value === 'number' || typeof value === 'string') {
                patch.defaultMagi2Duration = clampMagi2Duration(Number(value))
              }
              continue
            }
            if ((STRING_KEYS as readonly string[]).includes(key)) {
              if (typeof value === 'string') (patch as Record<string, unknown>)[key] = value.trim()
              continue
            }
            if (key === 'maxConcurrent') {
              // 并发闸门是插件 config 项，不进 user config；这里明确拒绝而不是静默忽略
              rejected.push(key + '（请在插件配置里设置）')
              continue
            }
            if (value !== undefined) rejected.push(key)
          }
          writeUserConfig(patch)
          // 只回显掩码，绝不回显明文
          writeJson(res, 200, {
            ok: true,
            written: Object.keys(patch),
            rejected,
            hints: {
              ark: keyHint(patch.arkApiKey ?? providerConfig().arkApiKey),
              minimax: keyHint(patch.minimaxApiKey ?? providerConfig().minimaxApiKey),
              sand: keyHint(patch.sandApiKey ?? providerConfig().sandApiKey),
            },
            path: join(dshHome(), 'video-forge.json'),
          })
          return
        }

        // POST /produce —— 后台跑，立刻返回 job id
        if (rest === '/produce' && req.method === 'POST') {
          const body = (await readJsonBody(req, 4 * 1024 * 1024)) as Record<string, unknown>
          const storyboard = buildStoryboard(body)
          const started = Date.now()
          const jobId = runtime.nextJobId('job')
          let created: JobRecord | undefined
          const promise = runtime.produce(storyboard, {
            jobId,
            onJob: job => { created = job },
            defaultStrategy: strategyOf(body.defaultStrategy),
            seedreamModel: typeof body.seedreamModel === 'string' ? body.seedreamModel : undefined,
            minimaxModel: typeof body.minimaxModel === 'string' ? body.minimaxModel : undefined,
            minimaxResolution: typeof body.minimaxResolution === 'string' ? body.minimaxResolution : undefined,
            magi2Model: typeof body.magi2Model === 'string' ? body.magi2Model : (config.defaultMagi2Model ?? 'MAGI-2'),
            magi2Duration: Number.isFinite(Number(body.magi2Duration)) ? Number(body.magi2Duration) : undefined,
            generateAudio: typeof body.generateAudio === 'boolean' ? body.generateAudio : undefined,
            depthWorkflow: typeof body.depthWorkflow === 'string' ? body.depthWorkflow : undefined,
            matteWorkflow: typeof body.matteWorkflow === 'string' ? body.matteWorkflow : undefined,
            plateWorkflow: typeof body.plateWorkflow === 'string' ? body.plateWorkflow : undefined,
            qualityMode: qualityModeOf(body.qualityMode),
            enablePlate: body.enablePlate === true,
            preset: typeof body.preset === 'string' ? body.preset : undefined,
            mock: body.mock === true,
            dryRun: body.dryRun === true,
            useCache: body.useCache !== false,
            writePlan: body.writePlan !== false,
            concurrency: config.maxConcurrent ?? 3,
          })
          // 交给事件循环，路由不阻塞。produce 在第一个 await 之前就登记了作业，
          // 所以此刻 created 一定已经就位 —— 前端可以直接锁定 jobId，无需 800ms 盲猜刷新。
          void promise.catch(() => { /* 已记在 job.error */ })
          writeJson(res, 202, {
            ok: true,
            jobId,
            job: created === undefined ? { id: jobId, status: 'running' } : statusOf(created),
            acceptedAt: started,
            hint: '用 GET /jobs?id=' + jobId + ' 增量拉事件（since=事件游标）',
          })
          return
        }

        // POST /jobs/:id/cancel —— 真实取消（中止排队 + 中止 Provider 轮询）
        if (rest.startsWith('/jobs/') && rest.endsWith('/cancel') && req.method === 'POST') {
          const id = decodeURIComponent(rest.slice('/jobs/'.length, -'/cancel'.length))
          const outcome = runtime.cancelJob(id)
          if (outcome.job === undefined) {
            writeJson(res, 404, { ok: false, error: outcome.reason ?? '作业不存在' })
            return
          }
          writeJson(res, outcome.ok ? 202 : 409, {
            ok: outcome.ok,
            jobId: id,
            job: statusOf(outcome.job),
            reason: outcome.reason,
            hint: outcome.ok ? '取消已下发：进行中的 Provider 调用会被 abort，排队任务立即置 cancelled' : undefined,
          })
          return
        }

        // POST /jobs/:id/replay —— 待配额作业一键重放（配额到位后即可产出）
        if (rest.startsWith('/jobs/') && rest.endsWith('/replay') && req.method === 'POST') {
          const id = decodeURIComponent(rest.slice('/jobs/'.length, -'/replay'.length))
          try {
            const jobId = runtime.nextJobId('job')
            const source = runtime.getJob(id)
            if (source === undefined) {
              writeJson(res, 404, { ok: false, error: '作业不存在：' + id })
              return
            }
            if (source.requestSnapshot === undefined) {
              writeJson(res, 409, { ok: false, error: '该作业没有参数快照，无法重放（请用面板「载入当前表单编辑」）' })
              return
            }
            let created: JobRecord | undefined
            const snapshot = source.requestSnapshot
            const promise = runtime.produce(snapshot['storyboard'] as never, {
              ...((snapshot['options'] ?? {}) as Record<string, unknown>),
              jobId,
              onJob: (job: JobRecord) => { created = job },
            } as never)
            void promise.catch(() => { /* 已记在 job.error */ })
            writeJson(res, 202, {
              ok: true,
              jobId,
              job: created === undefined ? { id: jobId, status: 'running' } : statusOf(created),
              replayedFrom: id,
            })
          } catch (error) {
            writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // GET /jobs?limit=&since=  —— 面板轮询
        if (rest === '/jobs' && req.method === 'GET') {
          const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') ?? '10') || 10))
          const jobs = runtime.listJobs(limit).map(job => ({ ...job }))
          const id = url.searchParams.get('id')
          if (id !== null) {
            const job = runtime.getJob(id)
            if (job === undefined) {
              writeJson(res, 404, { ok: false, error: 'job 不存在：' + id })
              return
            }
            const since = Number(url.searchParams.get('since') ?? '0') || 0
            writeJson(res, 200, { ok: true, job: statusOf(job), events: job.events.slice(since) })
            return
          }
          writeJson(res, 200, { ok: true, jobs })
          return
        }

        // GET /plans, GET /plan/:id
        if (rest === '/plans' && req.method === 'GET') {
          const rows = runtime.listPlans(30).map((row) => {
            const plan = runtime.readPlan(row.planId)
            return plan === null ? row : { ...row, preview: runtime.planPreview(plan) }
          })
          writeJson(res, 200, { ok: true, plans: rows, fetchedAt: Date.now() })
          return
        }
        if (rest.startsWith('/plan/') && req.method === 'GET') {
          const planId = decodeURIComponent(rest.slice('/plan/'.length))
          const plan = runtime.readPlan(planId)
          if (plan === null) {
            writeJson(res, 404, { ok: false, error: 'plan 不存在：' + planId })
            return
          }
          writeJson(res, 200, {
            ok: true,
            plan,
            issues: runtime.checkPlan(plan),
            // 每个镜头可直接预览的 fileKey（对接 GET /file/<fileKey>）
            preview: runtime.planPreview(plan),
            fetchedAt: Date.now(),
          })
          return
        }

        // GET /workflows
        if (rest === '/workflows' && req.method === 'GET') {
          writeJson(res, 200, { ok: true, dir: providerConfig().workflowDir, workflows: runtime.listWorkflows() })
          return
        }

        // POST /check-plan —— 校验任意 plan JSON
        if (rest === '/check-plan' && req.method === 'POST') {
          const body = (await readJsonBody(req, 4 * 1024 * 1024)) as { plan?: RenderPlan }
          if (body.plan === undefined) {
            writeJson(res, 400, { ok: false, error: '需要 plan 字段' })
            return
          }
          const issues = runtime.checkPlan(body.plan)
          writeJson(res, 200, { ok: issues.every(i => i.level !== 'error'), issues })
          return
        }

        // POST /bridge —— ComfyUI 自定义节点回连宿主（DshForgeBridgeCall 打的就是这里）
        if (rest === '/bridge' && req.method === 'POST') {
          const cfg = providerConfig()
          const expected = cfg.bridgeToken !== '' ? cfg.bridgeToken : (process.env.DSH_FORGE_BRIDGE_TOKEN ?? '')
          const provided = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
          if (expected !== '' && provided !== expected) {
            writeJson(res, 401, { ok: false, error: 'bridge token 不匹配（检查节点的 api_key_env 或插件 bridgeToken）' })
            return
          }
          if (expected === '') {
            console.warn('[video-forge] 未配置 bridgeToken：桥接端点只靠回环地址保护，跨进程调用请设置 DSH_FORGE_TOKEN')
          }
          const body = (await readJsonBody(req, 1 * 1024 * 1024)) as { action?: string; params?: Record<string, unknown> }
          const action = String(body.action ?? '').trim()
          const params = (body.params ?? {}) as Record<string, unknown>
          const startedAt = Date.now()

          if (action === 'health') {
            const status = await runtime.status()
            writeJson(res, 200, {
              ok: true,
              action,
              ms: Date.now() - startedAt,
              providers: status.providers,
              cache: status.cache,
              plans: status.plans,
            })
            return
          }

          if (action === 'seedream_t2i' || action === 'seedream_i2i') {
            const result = await bridgeRun('seedream', 'image', {
              ...params,
              prompt: String(params.prompt ?? ''),
              ...(action === 'seedream_i2i' ? { image: params.image ?? params.referenceImage } : {}),
            }, [])
            writeJson(res, result.ok ? 200 : 502, { ok: result.ok, action, ms: Date.now() - startedAt, artifacts: result.artifacts, warnings: result.warnings, error: result.error })
            return
          }

          if (action === 'minimax_t2v' || action === 'minimax_i2v') {
            const provider = runtime.providers.require('minimax') as unknown as {
              submit: (p: Record<string, unknown>) => Promise<{ taskId: string; body: Record<string, unknown> }>
            }
            const submitted = await provider.submit({
              ...params,
              ...(action === 'minimax_i2v' ? { firstFrame: params.firstFrame ?? params.image } : {}),
            })
            // H3 出片 1–5 分钟，超出 ComfyUI 节点默认超时：提交即返回，由 minimax_status 轮询
            writeJson(res, 200, {
              ok: true,
              action,
              ms: Date.now() - startedAt,
              taskId: submitted.taskId,
              hint: '用 action=minimax_status&params.taskId=' + submitted.taskId + ' 轮询；succeeded 后 content.url 有时效，尽快下载',
            })
            return
          }

          if (action === 'minimax_status') {
            const provider = runtime.providers.require('minimax') as unknown as {
              queryTask: (id: string) => Promise<Record<string, unknown>>
            }
            const taskId = String(params.taskId ?? params.task_id ?? '')
            if (taskId === '') {
              writeJson(res, 400, { ok: false, error: '需要 params.taskId' })
              return
            }
            const task = await provider.queryTask(taskId)
            const content = (task.content ?? {}) as Record<string, unknown>
            writeJson(res, 200, {
              ok: task.status === 'succeeded',
              action,
              status: String(task.status ?? 'unknown'),
              url: typeof content.url === 'string' ? content.url : undefined,
              error: task.error,
              raw: task,
            })
            return
          }

          if (action === 'forge_task') {
            const providerId = String(params.provider ?? 'comfyui')
            const kind = String(params.kind ?? 'asset')
            const inner = (params.params ?? {}) as Record<string, unknown>
            const inputs = Array.isArray(params.inputs) ? params.inputs as never[] : []
            const result = await bridgeRun(providerId as never, kind as never, inner, inputs)
            writeJson(res, result.ok ? 200 : 502, { ok: result.ok, action, ms: Date.now() - startedAt, artifacts: result.artifacts, warnings: result.warnings, error: result.error })
            return
          }

          writeJson(res, 400, { ok: false, error: '未知 action：' + action + '（可用：health/seedream_t2i/seedream_i2i/minimax_t2v/minimax_i2v/minimax_status/forge_task）' })
          return
        }

        // GET /file/<o|c>/<rel...> —— 产物静态服务
        if (rest.startsWith('/file/') && req.method === 'GET') {
          const fileKey = decodeURIComponent(rest.slice('/file/'.length))
          const abs = runtime.resolveAssetPath(fileKey)
          const body = abs === null ? null : readFileDirect(abs)
          if (body === null) {
            writeJson(res, 404, { ok: false, error: 'not found: ' + fileKey })
            return
          }
          res.writeHead(200, {
            'content-type': body.contentType,
            'content-length': body.bytes.length,
            'cache-control': 'public, max-age=3600',
          })
          res.end(body.bytes)
          return
        }

        writeJson(res, 404, { ok: false, error: 'unknown route: ' + path })
      } catch (error) {
        try {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        } catch { /* 响应已结束 */ }
      }
    },
  }

  ctx.effect(() => ctx.webServer.register(route), '@dsh-external/dsh-video-forge: api routes')

  // 首次启动把默认 workflowDir 落到配置可见处（不写文件，只打日志）
  try {
    const dir = providerConfig().workflowDir
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch { /* 权限问题不阻塞 */ }
}

/** 把任意字符串归一成合法 strategy（不合法就退回 undefined，让编译器用默认值）。 */
/** 质量模式白名单：非法值一律按 production 处理（宁可拦住，也不要静默降级画质）。 */
function qualityModeOf(value: unknown): 'production' | 'draft' {
  return value === 'draft' ? 'draft' : 'production'
}

function strategyOf(value: unknown): CompileOptions['defaultStrategy'] {
  const allowed = ['seedream-static', 'still-3d', 'minimax-direct', 'minimax-2k-repaint', 'comfy-pipeline', 'magi2-direct', 'magi2-i2v'] as const
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as CompileOptions['defaultStrategy']
    : undefined
}

/** 把工具/路由入参归一成 StoryboardInput。 */
function buildStoryboard(input: Record<string, unknown>): StoryboardInput {
  const width = Number(input.width ?? 1920) || 1920
  const height = Number(input.height ?? 1080) || 1080
  const fps = Number(input.fps ?? 30) || 30
  const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : 'Video Forge Composition'

  let shots: StoryboardInput['shots'] = []
  if (Array.isArray(input.shots)) {
    shots = input.shots as StoryboardInput['shots']
  } else if (typeof input.markdownTable === 'string' && input.markdownTable.trim() !== '') {
    shots = parseStoryboardTable(input.markdownTable)
  }
  if (shots.length === 0) {
    // 没有任何分镜时给一个可跑通的占位分镜，避免空 DAG
    shots = [{
      id: 'shot-1',
      shot: '全景',
      durationSec: 4,
      prompt: 'a quiet horizon at dawn, soft gradient light, cinematic wide shot',
      description: '默认占位镜头',
    }]
  }

  const styleTags = typeof input.styleTags === 'string'
    ? input.styleTags.split(',').map(s => s.trim()).filter(s => s !== '')
    : []

  // planId 必须是**内容哈希**而不是时间戳：planId 参与 seedFor()，一旦每次都变，
  // 同一份输入重复生产时 seed 全变 → 内容寻址缓存永远打不中（实测白花过一次 Seedream）。
  const planId = typeof input.id === 'string'
    ? input.id
    : 'plan-' + hashSeed(JSON.stringify({ title, width, height, fps, preset: input.preset, styleTags, shots })).toString(36)

  return {
    id: planId,
    title,
    width,
    height,
    fps,
    preset: typeof input.preset === 'string' ? input.preset : undefined,
    style: styleTags.length > 0 ? { tags: styleTags } : undefined,
    shots,
  }
}

/** 供 tsdown 等外部工具引用的显式导出（避免 tree-shake 掉） */
export { ForgeRuntime }
