/**
 * 统一媒体任务契约 —— 调度层 / Provider 层 / 缓存层只认这些类型。
 *
 * 铁律：本文件（以及 core/ 下的一切）**不许**出现 three、镜头、风格这类概念。
 * 风格只存在于 bridge/ 的 RenderPlan 与 remotion/ 的渲染内核。
 */

export type MediaKind = 'image' | 'video' | 'asset'

export type ProviderId = 'seedream' | 'minimax' | 'magi2' | 'comfyui' | 'mock' | 'canvas'

/** 产物：磁盘路径 + 面板可访问 URL + 若干元数据。 */
export interface Artifact {
  id: string
  kind: MediaKind
  /** 绝对磁盘路径 */
  path: string
  /** 面板 HTTP URL（/api/dsh-video-forge/file/...） */
  url: string
  /** fileKey：'o/<rel>'（outDir）或 'c/<rel>'（cacheDir），路由按此前缀找根 */
  fileKey: string
  bytes: number
  mime?: string
  width?: number
  height?: number
  durationSec?: number
  meta?: Record<string, unknown>
}

export interface ProviderCapability {
  kind: MediaKind
  /** 该能力支持的模型/工作流名（空 = 不限） */
  models?: string[]
  /** 是否能离线 mock（面板据此判断"零成本预演"可行性） */
  mockable?: boolean
  note?: string
}

export type ProviderStatus = 'ok' | 'degraded' | 'offline' | 'unknown'

export interface ProviderHealth {
  provider: ProviderId
  status: ProviderStatus
  /** 一行人类可读结论 */
  detail: string
  latencyMs?: number
  /** 例如 comfyui: { version, vramFreeMiB, ramFreeMiB, queueRunning } */
  extra?: Record<string, unknown>
  checkedAt: number
}

export interface TaskInput {
  /** 语义角色：depth / mask / first_frame / layer / reference ... */
  role: string
  path?: string
  url?: string
  /** 由 DAG 上游产物提供（调度器填） */
  artifactId?: string
}

export interface TaskRequest {
  id: string
  provider: ProviderId
  kind: MediaKind
  /** 官方 API 参数直通（不做模板限制）；也承载 comfyui 的 workflow/context */
  params: Record<string, unknown>
  inputs?: TaskInput[]
  /** 调度层填入的上游节点 id（缓存指纹不包含它，包含上游指纹） */
  deps?: string[]
  /** 失败是否允许跳过而不拖垮整条 DAG */
  optional?: boolean
  /** 失败后的降级策略 */
  fallback?: 'skip' | 'mock' | 'canvas'
}

export interface RunEvent {
  type: 'queued' | 'start' | 'progress' | 'log' | 'done' | 'error' | 'skip' | 'cache'
  taskId: string
  provider: string
  at: number
  message?: string
  progress?: number
  data?: unknown
}

export interface RunContext {
  emit: (event: RunEvent) => void
  /** 复用的缓存实现（由 runtime 注入，避免 provider 直接碰 fs 布局） */
  cache: CacheLike
  dryRun: boolean
  mock: boolean
  signal?: AbortSignal
  log: (message: string) => void
  /** 落盘到 outDir/<sub>/<name>，返回 Artifact（url/fileKey 已填好） */
  save: (sub: string, fileName: string, bytes: Buffer, meta: TaskArtifactMeta) => Artifact
  /** 临时目录（上传给 ComfyUI 的中间文件等） */
  tmpDir: string
  /** 当前 provider 的配置快照（只读） */
  config: ProviderConfig
}

export interface TaskArtifactMeta {
  id?: string
  kind?: MediaKind
  mime?: string
  width?: number
  height?: number
  durationSec?: number
  meta?: Record<string, unknown>
}

export interface ProviderConfig {
  arkBaseUrl: string
  arkApiKey: string
  defaultSeedreamModel: string
  minimaxBaseUrl: string
  minimaxApiKey: string
  defaultMinimaxModel: string
  minimaxResolution: string
  /** Sand.ai 官方直连基址（MAGI-2） */
  sandBaseUrl: string
  sandApiKey: string
  /** MAGI-2 默认时长（秒，4–30 整数） */
  defaultMagi2Duration: number
  comfyBaseUrl: string
  /** ComfyUI 工作流目录（按 workflowName 查找 .json） */
  workflowDir: string
  outputDir: string
  bridgeToken: string
  /** ffmpeg 可执行文件（mock 视频合成用；为空则 mock 视频退化为静帧） */
  ffmpegPath: string
}

export interface TaskResult {
  ok: boolean
  taskId: string
  provider: ProviderId
  artifacts: Artifact[]
  seconds: number
  cached: boolean
  warnings: string[]
  usage?: Record<string, unknown>
  error?: string
  /** dry-run 时说明"本来会调用什么" */
  wouldCall?: Record<string, unknown>
}

export interface MediaProvider {
  id: ProviderId
  label: string
  capabilities(): ProviderCapability[]
  health(): Promise<ProviderHealth>
  run(request: TaskRequest, ctx: RunContext): Promise<TaskResult>
}

export interface CacheEntry {
  fingerprint: string
  files: Array<{ fileKey: string; path: string; bytes: number; name: string }>
  meta: Record<string, unknown>
  createdAt: number
}

/**
 * Provider 侧的外部资源索引（例：Sand.ai 的 SHA256 → assetId 上传映射）。
 * 交给缓存池托管，才能与产物缓存共用一套统计、清理与跨会话复用。
 */
export interface AssetIndexLike {
  /** 读取整份索引（内容原样返回，Provider 自己决定结构） */
  read(): Record<string, unknown>
  /** 覆盖写入整份索引 */
  write(map: Record<string, unknown>): void
  /** GC：删掉 exists() 返回 false 的条目，返回删/留计数 */
  prune(exists: (key: string, value: unknown) => boolean): { removed: number; kept: number }
}

export interface CacheLike {
  fingerprint(request: TaskRequest, extra?: Record<string, unknown>): string
  read(fingerprint: string): CacheEntry | null
  write(fingerprint: string, result: TaskResult, files: Array<{ path: string; name: string }>): CacheEntry | null
  stats(): { entries: number; bytes: number }
  /** 命中缓存时把 CacheEntry 还原成 Artifact[] */
  artifacts(entry: CacheEntry): Artifact[]
  /** 可选：Provider 资源索引托管（未实现时 Provider 自行落盘） */
  assetIndex?(name: string): AssetIndexLike
}

/** 可重试 / 不可重试的显式错误。provider 抛它来指导调度器。 */
export class ForgeError extends Error {
  readonly retryable: boolean
  readonly detail?: Record<string, unknown>
  /**
   * 机器可读错误码（供上层判定"不是所有失败都一样"）：
   *   pending_quota —— 官方已鉴权但配额未下发（Sand.ai 400 insufficient_credits），
   *                    调用方应把作业标为 pending_quota 并保留可重放草稿，绝不当作普通失败重试。
   */
  readonly code?: string

  constructor(message: string, retryable = false, detail?: Record<string, unknown>, code?: string) {
    super(message)
    this.name = 'ForgeError'
    this.retryable = retryable
    this.detail = detail
    this.code = code
  }
}

export function artifactUrl(fileKey: string): string {
  return '/api/dsh-video-forge/file/' + fileKey.split('/').map(encodeURIComponent).join('/')
}

export function isForgeError(error: unknown): error is ForgeError {
  return error instanceof ForgeError
}

/** 官方配额未下发（不是失败，是"待激活"）：调度器据此不重试、上层据此保留草稿。 */
export const PENDING_QUOTA_CODE = 'pending_quota'

export function isPendingQuota(error: unknown): boolean {
  if (error instanceof ForgeError) return error.code === PENDING_QUOTA_CODE
  const code = (error as { code?: unknown } | null | undefined)?.code
  return code === PENDING_QUOTA_CODE
}
