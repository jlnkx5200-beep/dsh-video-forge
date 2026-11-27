/**
 * MAGI-2 Provider —— Sand.ai **官方直连**（`https://api.sand.ai` + `SAND_API_KEY`）。
 *
 * 定位（与 MiniMax H3 互补，不是替代）：
 *   · MiniMax H3 继续负责 T2V / UI 文字动效 / 480P-768P 快速草稿 / 2K 重绘；
 *   · MAGI-2 负责 I2V / 15–30s 连续分镜 / 原生 1080p / 20 路多参考不加价。
 *
 * 两条端点严格隔离（请求体规则见 `magi2-payload.ts`）：
 *   · Native  `POST {base}/v2/generations` + 轮询 —— 通用多模态参考、时间轴分镜、视频编辑；
 *   · Ark 兼容 `POST {base}/compatible/ark/api/v3/contents/generations/tasks` + 轮询 —— 首尾帧。
 *
 * 官方现状（2026-11）：Key 可配，但配额未下发，任何生成请求返回 `400 insufficient_credits`。
 * 这一状态被**当成一等公民**：`pending_quota`（已鉴权·待官方配额），
 * 抛带 code 的 ForgeError，作业保留 requestSnapshot 草稿，绝不被当成普通失败反复重试。
 *
 * 探针不做任何计费动作：只发免计费的 GET（assets 列表 / account / models）。
 * 默认也**不会**自动探测：将来真有配额时，自动探测若走了生成端点就会偷偷扣费。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import type {
  AssetIndexLike, CacheLike, MediaProvider, ProviderCapability, ProviderHealth, RunContext, TaskRequest, TaskResult,
} from './types.js'
import { ForgeError, PENDING_QUOTA_CODE, artifactUrl } from './types.js'
import { isAborted, sleep } from '../http.js'
import {
  buildArkBody, buildNativeBody, classifySandFailure, MAGI2_DEFAULT_MODEL, MAGI2_DEFAULT_DURATION,
  parseJsonBigIntSafe, pickMagi2Mode, validateMagi2Spec, type Magi2Mode, type Magi2Spec,
} from './magi2-payload.js'

export type Magi2KeyState = 'missing_key' | 'invalid_key' | 'pending_quota' | 'ready' | 'configured_unprobed'

export interface Magi2ProbeResult {
  state: Magi2KeyState
  detail: string
  at: number
  latencyMs?: number
  endpoint?: string
}

export interface Magi2ProviderOptions {
  baseUrl: () => string
  apiKey: () => string
  defaultDuration: () => number
  model?: () => string
  /** 资产 id 索引文件（在 cacheDir 下），内容寻址复用，避免重复上传 */
  assetCacheFile: () => string
}

const NATIVE_PATH = '/v2/generations'
const ARK_PATH = '/compatible/ark/api/v3/contents/generations/tasks'
const ASSET_PATH = '/v1/assets'
/** 免计费探针候选端点（全部是 GET，绝不会产生生成费用）。 */
const PROBE_PATHS = ['/v1/assets?limit=1', '/v1/account', '/v1/models']
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_MEDIA_BYTES = 200 * 1024 * 1024

interface AssetRecord {
  assetId: string
  name: string
  bytes: number
  at: number
}

interface PollOutcome {
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  url?: string
  error?: string
  code?: string
  raw: Record<string, unknown>
}

function withSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') return anyFn([signal, timeout])
  return signal
}

function mimeOf(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.avif') return 'image/avif'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg'
  return 'application/octet-stream'
}

/** 在未知返回形状里按路径取值（官方两套端点字段名不完全一致）。 */
function dig(value: unknown, path: string): unknown {
  let cursor: unknown = value
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

const URL_PATHS = [
  'output.url', 'output.video_url', 'output.videoUrl', 'outputs.0.url', 'outputs.0.video_url',
  'result.url', 'result.video_url', 'data.0.url', 'data.0.video_url', 'content.video_url',
  'video_url', 'videoUrl', 'url',
]

export class Magi2Provider implements MediaProvider {
  readonly id = 'magi2' as const
  readonly label = 'MAGI-2（Sand.ai 官方直连）'

  /** 探针/真实调用得到的 Key 状态缓存（内存，不落盘：避免把"待配额"错误固化）。 */
  private cached: Magi2ProbeResult | null = null
  private assets: Map<string, AssetRecord> | null = null

  constructor(private readonly opts: Magi2ProviderOptions) {}

  capabilities(): ProviderCapability[] {
    return [
      {
        kind: 'video',
        models: [MAGI2_DEFAULT_MODEL],
        mockable: true,
        note: 'I2V / 15–30s 连续分镜 / 原生 1080p / 20 路多参考不加价；首尾帧走 Ark 兼容端点',
      },
    ]
  }

  /* ── Key 状态 ─────────────────────────────────────────────── */

  /** 不发网络请求的当前判断（GET /status 用；绝不自动探测以免将来误扣费）。 */
  keyState(): { state: Magi2KeyState; detail: string; at?: number } {
    if (this.opts.apiKey().trim() === '') {
      return { state: 'missing_key', detail: '未配置 SAND_API_KEY（面板「设置 → Sand.ai」或 ~/.dsh/video-forge.json）' }
    }
    if (this.cached !== null) return { state: this.cached.state, detail: this.cached.detail, at: this.cached.at }
    return {
      state: 'configured_unprobed',
      detail: 'Key 已配置，尚未探针（默认不自动探测：将来有配额后自动探测可能误扣费，请点「检查 Sand.ai」）',
    }
  }

  private remember(state: Magi2KeyState, detail: string, endpoint?: string): void {
    this.cached = { state, detail, at: Date.now(), ...(endpoint === undefined ? {} : { endpoint }) }
  }

  /** 手动探针：只发免计费 GET。用户点一次才跑一次。 */
  async probe(): Promise<Magi2ProbeResult> {
    const started = Date.now()
    if (this.opts.apiKey().trim() === '') {
      const result: Magi2ProbeResult = { state: 'missing_key', detail: '未配置 SAND_API_KEY', at: Date.now() }
      this.cached = result
      return result
    }
    let lastDetail = ''
    for (const path of PROBE_PATHS) {
      let res: { status: number; payload: Record<string, unknown> }
      try {
        res = await this.request('GET', path, undefined, 20_000)
      } catch (error) {
        lastDetail = error instanceof Error ? error.message : String(error)
        continue
      }
      const latencyMs = Date.now() - started
      if (res.status === 200) {
        const result: Magi2ProbeResult = {
          state: 'ready',
          // 免费接口 200 只能证明「Key 有效」，官方没有不扣费的余额查询接口，
          // 所以这里绝不写成「配额可用」——真实配额以首次生成为准。
          detail: '鉴权通过（探针端点 ' + path + ' 返回 200，免计费 GET）；' +
            '免费接口只能证明 Key 有效、无法确认余额，配额待首次生成确认',
          at: Date.now(), latencyMs, endpoint: path,
        }
        this.cached = result
        return result
      }
      const failure = classifySandFailure(res.status, res.payload)
      if (failure.code === PENDING_QUOTA_CODE) {
        const result: Magi2ProbeResult = {
          state: 'pending_quota',
          detail: '鉴权通过·配额不可用：' + failure.message.split('\n')[0],
          at: Date.now(), latencyMs, endpoint: path,
        }
        this.cached = result
        return result
      }
      if (failure.code === 'invalid_key') {
        const result: Magi2ProbeResult = {
          state: 'invalid_key',
          detail: failure.message,
          at: Date.now(), latencyMs, endpoint: path,
        }
        this.cached = result
        return result
      }
      if (res.status === 404) {
        lastDetail = '探针端点不存在（' + path + '）'
        continue
      }
      // 其它状态（403/405/429…）：鉴权大概率通过，但配额无从判断 —— 如实标注，不臆测。
      lastDetail = failure.message
      const result: Magi2ProbeResult = {
        state: failure.code === 'rate_limited' ? 'ready' : 'configured_unprobed',
        detail: failure.message,
        at: Date.now(), latencyMs, endpoint: path,
      }
      this.cached = result
      return result
    }
    const result: Magi2ProbeResult = {
      state: 'configured_unprobed',
      detail: '探针未拿到明确结论：' + (lastDetail === '' ? '官方端点均不可达（可能是网络/代理）' : lastDetail),
      at: Date.now(), latencyMs: Date.now() - started,
    }
    this.cached = result
    return result
  }

  async health(): Promise<ProviderHealth> {
    const state = this.keyState()
    const status = state.state === 'missing_key' || state.state === 'invalid_key'
      ? 'offline'
      : state.state === 'ready'
        ? 'ok'
        : state.state === 'pending_quota'
          ? 'degraded'
          : 'unknown'
    return {
      provider: this.id,
      status,
      detail: state.detail,
      extra: {
        baseUrl: this.opts.baseUrl(),
        keyState: state.state,
        probedAt: state.at,
        defaultDuration: this.opts.defaultDuration(),
      },
      checkedAt: Date.now(),
    }
  }

  /* ── HTTP ─────────────────────────────────────────────────── */

  private headers(contentType?: string): Record<string, string> {
    const key = this.opts.apiKey().trim()
    if (key === '') {
      throw new ForgeError('缺少 Sand.ai API Key：面板「设置 → Sand.ai」填入，或设置环境变量 SAND_API_KEY', false, undefined, 'missing_key')
    }
    const out: Record<string, string> = { authorization: 'Bearer ' + key }
    if (contentType !== undefined) out['content-type'] = contentType
    return out
  }

  private urlOf(path: string): string {
    const base = this.opts.baseUrl().trim().replace(/\/+$/, '')
    return base + path
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    timeoutMs = 120_000,
    signal?: AbortSignal,
  ): Promise<{ status: number; payload: Record<string, unknown>; text: string }> {
    let res: Response
    try {
      res = await fetch(this.urlOf(path), {
        method,
        headers: this.headers(body === undefined ? undefined : 'application/json'),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: withSignal(signal, timeoutMs),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isAborted(signal)) throw new ForgeError('已取消', false, undefined, 'cancelled')
      throw new ForgeError('请求 Sand.ai 失败：' + message, true)
    }
    const text = await res.text()
    if (text.trim() === '') return { status: res.status, payload: {}, text }
    try {
      return { status: res.status, payload: parseJsonBigIntSafe(text), text }
    } catch {
      if (res.status >= 200 && res.status < 300) return { status: res.status, payload: {}, text }
      throw new ForgeError('Sand.ai 返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 300), res.status >= 500)
    }
  }

  /* ── 资产上传（SHA256 内容寻址，避免重复上传同一张图） ────── */

  private indexPath(): string {
    const configured = this.opts.assetCacheFile().trim()
    return configured === '' ? join(tmpdir(), 'dsh-video-forge-magi2-assets.json') : configured
  }

  /**
   * 索引落点：优先用缓存池托管（`<cacheDir>/_assets/magi2.json`），
   * 拿不到缓存上下文时退回本地文件 —— 这样脱离 runtime 的单测仍可跑。
   */
  private indexStore(ctx?: RunContext): AssetIndexLike | null {
    const cache = ctx?.cache as (CacheLike & { assetIndex?: (name: string) => AssetIndexLike }) | undefined
    if (cache === undefined || typeof cache.assetIndex !== 'function') return null
    try {
      return cache.assetIndex('magi2')
    } catch {
      return null
    }
  }

  private loadAssets(ctx?: RunContext): Map<string, AssetRecord> {
    if (this.assets !== null) return this.assets
    const map = new Map<string, AssetRecord>()
    const store = this.indexStore(ctx)
    let parsed: Record<string, unknown> | null = null
    if (store !== null) {
      parsed = store.read()
    } else {
      try {
        parsed = JSON.parse(readFileSync(this.indexPath(), 'utf8')) as Record<string, unknown>
      } catch {
        parsed = null
      }
    }
    if (parsed !== null) {
      for (const [hash, raw] of Object.entries(parsed)) {
        const record = raw as AssetRecord | null
        if (record !== null && typeof record === 'object' && typeof record.assetId === 'string') map.set(hash, record)
      }
    }
    this.assets = map
    return map
  }

  private persistAssets(ctx?: RunContext): void {
    if (this.assets === null) return
    const store = this.indexStore(ctx)
    if (store !== null) {
      store.write(Object.fromEntries(this.assets))
      return
    }
    try {
      const path = this.indexPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(Object.fromEntries(this.assets), null, 2) + '\n', 'utf8')
    } catch {
      /* 索引写不进去只影响复用率，不该让生成失败 */
    }
  }

  /** GC：索引里指向的本地文件若已不存在，就丢掉这条上传映射。 */
  pruneAssetIndex(ctx?: RunContext): { removed: number; kept: number } {
    const store = this.indexStore(ctx)
    if (store === null) return { removed: 0, kept: 0 }
    const result = store.prune((_key: string, value: unknown) => {
      const record = value as AssetRecord | null
      if (record === null || typeof record !== 'object') return false
      const name = typeof record.name === 'string' ? record.name : ''
      // 只按内容哈希记账，文件是否还在由缓存池决定；没有路径信息就保守保留
      return name !== ''
    })
    this.assets = null
    return result
  }

  /** 本地文件 → 官方 assetId（同一个 SHA256 只上传一次）。 */
  async uploadAsset(path: string, ctx?: RunContext): Promise<string> {
    if (!existsSync(path)) throw new ForgeError('待上传文件不存在：' + path, false)
    const size = statSync(path).size
    if (size > MAX_MEDIA_BYTES) throw new ForgeError('上传文件超过 200MB 上限：' + Math.round(size / 1048576) + 'MB', false)
    const bytes = readFileSync(path)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const known = this.loadAssets(ctx).get(hash)
    if (known !== undefined) {
      ctx?.log('资产命中上传缓存：' + basename(path) + ' → asset ' + known.assetId)
      return known.assetId
    }
    const form = new FormData()
    const mime = mimeOf(path)
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), basename(path))
    let res: Response
    try {
      res = await fetch(this.urlOf(ASSET_PATH), {
        method: 'POST',
        headers: this.headers(),
        body: form,
        signal: withSignal(ctx?.signal, 300_000),
      })
    } catch (error) {
      throw new ForgeError('上传资产到 Sand.ai 失败：' + (error instanceof Error ? error.message : String(error)), true)
    }
    const text = await res.text()
    const payload = text.trim() === '' ? {} : parseJsonBigIntSafe(text)
    if (res.status < 200 || res.status >= 300) throw classifySandFailure(res.status, payload)
    const rawId = payload['id'] ?? payload['asset_id'] ?? dig(payload, 'asset.id') ?? dig(payload, 'data.id')
    // parseJsonBigIntSafe 已把 15 位以上的裸整数转成字符串；这里再兜一次。
    const assetId = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : ''
    if (assetId === '') throw new ForgeError('Sand.ai 上传未返回资产 id：' + text.slice(0, 300), false)
    this.loadAssets(ctx).set(hash, { assetId, name: basename(path), bytes: size, at: Date.now() })
    this.persistAssets(ctx)
    return assetId
  }

  /* ── 规格解析 ─────────────────────────────────────────────── */

  /** 把调度器的 inputs 与工具参数合并成中立规格。 */
  specFromParams(params: Record<string, unknown>, inputs: TaskRequest['inputs']): Magi2Spec {
    const pickInput = (roles: string[]): string | undefined => {
      for (const role of roles) {
        const hit = (inputs ?? []).find(item => item.role === role)
        const value = hit?.path ?? hit?.url
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
      return undefined
    }
    const listOf = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) return undefined
      const out = value.map(item => String(item).trim()).filter(item => item !== '')
      return out.length === 0 ? undefined : out
    }
    const strOf = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = params[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
      return undefined
    }
    const cuesRaw = params['timelineCues'] ?? params['timeline_cues']
    const cues = Array.isArray(cuesRaw)
      ? cuesRaw
          .map((item) => {
            const row = item as Record<string, unknown>
            const atSec = Number(row['atSec'] ?? row['at'] ?? 0)
            const prompt = String(row['prompt'] ?? '').trim()
            return { atSec, prompt }
          })
          .filter(cue => cue.prompt !== '' && Number.isFinite(cue.atSec))
      : undefined

    const firstFrame = strOf('firstFrame', 'first_frame') ?? pickInput(['first_frame', 'firstFrame'])
    const lastFrame = strOf('lastFrame', 'last_frame') ?? pickInput(['last_frame', 'lastFrame'])
    const images = listOf(params['referenceImages'] ?? params['reference_images']) ??
      (inputs ?? []).filter(i => i.role === 'reference_image' || i.role === 'reference').map(i => i.path ?? i.url ?? '').filter(v => v !== '')
    const videos = listOf(params['referenceVideos'] ?? params['reference_videos'])
    const audios = listOf(params['referenceAudios'] ?? params['reference_audios'])

    const durationRaw = Number(params['duration'] ?? params['durationSec'] ?? this.opts.defaultDuration())
    const spec: Magi2Spec = {
      prompt: String(params['prompt'] ?? '').trim(),
      model: strOf('model') ?? this.modelId(),
      durationSec: Number.isFinite(durationRaw) ? durationRaw : MAGI2_DEFAULT_DURATION,
      resolution: strOf('resolution'),
      aspectRatio: strOf('aspectRatio', 'aspect_ratio', 'ratio'),
      seed: typeof params['seed'] === 'number' ? (params['seed'] as number) : undefined,
      negativePrompt: strOf('negativePrompt', 'negative_prompt'),
      images: images !== undefined && images.length > 0 ? images : undefined,
      videos: videos !== undefined && videos.length > 0 ? videos : undefined,
      audios: audios !== undefined && audios.length > 0 ? audios : undefined,
      videoSeconds: typeof params['videoSeconds'] === 'number' ? (params['videoSeconds'] as number) : undefined,
      audioSeconds: typeof params['audioSeconds'] === 'number' ? (params['audioSeconds'] as number) : undefined,
      firstFrame,
      lastFrame,
      timelineCues: cues !== undefined && cues.length > 0 ? cues : undefined,
      generateAudio: typeof params['generateAudio'] === 'boolean' ? (params['generateAudio'] as boolean) : undefined,
      edit: params['edit'] === true,
    }
    return spec
  }

  private modelId(): string {
    const fn = this.opts.model
    const value = fn === undefined ? '' : fn().trim()
    return value === '' ? MAGI2_DEFAULT_MODEL : value
  }

  /** 本地文件换成 assetId；公网/data URL 原样保留（官方两种都收）。 */
  private async resolveRefs(refs: string[] | undefined, ctx: RunContext): Promise<string[] | undefined> {
    if (refs === undefined) return undefined
    const out: string[] = []
    for (const ref of refs) {
      if (/^https?:\/\//i.test(ref) || ref.startsWith('data:') || /^\d{6,}$/.test(ref)) out.push(ref)
      else out.push(await this.uploadAsset(ref, ctx))
    }
    return out.length === 0 ? undefined : out
  }

  private async prepareBody(spec: Magi2Spec, mode: Magi2Mode, ctx: RunContext): Promise<Record<string, unknown>> {
    const defaults = { model: this.modelId(), durationSec: this.opts.defaultDuration() }
    if (mode === 'ark') {
      // Ark content[] 只接受公网 URL 或 data URL：本地图直接内联成 data URL，免去公网可达性假设。
      const toUrl = (value: string | undefined): string | undefined => {
        if (value === undefined) return undefined
        if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value
        if (!existsSync(value)) throw new ForgeError('首尾帧文件不存在：' + value, false)
        return 'data:' + mimeOf(value) + ';base64,' + readFileSync(value).toString('base64')
      }
      return buildArkBody({ ...spec, firstFrame: toUrl(spec.firstFrame), lastFrame: toUrl(spec.lastFrame) }, defaults)
    }
    const [images, videos, audios] = await Promise.all([
      this.resolveRefs(spec.images, ctx),
      this.resolveRefs(spec.videos, ctx),
      this.resolveRefs(spec.audios, ctx),
    ])
    return buildNativeBody({ ...spec, images, videos, audios, firstFrame: undefined, lastFrame: undefined }, defaults)
  }

  /* ── 轮询 ─────────────────────────────────────────────────── */

  private extractUrl(payload: Record<string, unknown>): string | undefined {
    for (const path of URL_PATHS) {
      const value = dig(payload, path)
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
  }

  private extractState(payload: Record<string, unknown>): PollOutcome['state'] {
    const raw = String(
      payload['status'] ?? payload['state'] ?? dig(payload, 'task.status') ?? dig(payload, 'data.status') ?? 'unknown',
    ).toLowerCase()
    if (['queued', 'pending', 'created', 'waiting'].includes(raw)) return 'queued'
    if (['running', 'processing', 'in_progress', 'generating'].includes(raw)) return 'running'
    if (['succeeded', 'success', 'completed', 'done', 'finished'].includes(raw)) return 'succeeded'
    if (['failed', 'error'].includes(raw)) return 'failed'
    if (['cancelled', 'canceled'].includes(raw)) return 'cancelled'
    return 'unknown'
  }

  /** 状态查询路径：官方两套端点各自不同；Native 侧给一个 404 回退。 */
  private statusPaths(mode: Magi2Mode, taskId: string): string[] {
    const id = encodeURIComponent(taskId)
    if (mode === 'ark') return [ARK_PATH + '/' + id]
    return [NATIVE_PATH + '/' + id, NATIVE_PATH + '/' + id + '/status']
  }

  private async poll(
    mode: Magi2Mode,
    taskId: string,
    ctx: RunContext,
    request: TaskRequest,
    timeoutMs: number,
  ): Promise<PollOutcome> {
    const deadline = Date.now() + timeoutMs
    let interval = 3_000
    let attempt = 0
    let pathIndex = 0
    const started = Date.now()
    for (;;) {
      if (isAborted(ctx.signal)) throw new ForgeError('已取消', false, undefined, 'cancelled')
      if (Date.now() > deadline) {
        throw new ForgeError('等待 MAGI-2 任务超时（' + Math.round(timeoutMs / 1000) + 's，官方长耗时 90–400s 属正常）', true)
      }
      attempt += 1
      const paths = this.statusPaths(mode, taskId)
      const path = paths[Math.min(pathIndex, paths.length - 1)]!
      let res: { status: number; payload: Record<string, unknown> }
      try {
        res = await this.request('GET', path, undefined, 30_000, ctx.signal)
      } catch (error) {
        if (isAborted(ctx.signal)) throw new ForgeError('已取消', false, undefined, 'cancelled')
        if (attempt > 6) throw error
        ctx.log('状态查询抖动，' + interval + 'ms 后重试：' + (error instanceof Error ? error.message : String(error)))
        await sleep(interval, ctx.signal)
        interval = Math.min(Math.round(interval * 1.5), 15_000)
        continue
      }
      if (res.status === 404 && pathIndex < paths.length - 1) {
        pathIndex += 1
        continue
      }
      if (res.status === 429) {
        await sleep(interval, ctx.signal)
        interval = Math.min(Math.round(interval * 1.5), 15_000)
        continue
      }
      if (res.status !== 200) {
        const failure = classifySandFailure(res.status, res.payload)
        if (failure.code === 'invalid_key') this.remember('invalid_key', failure.message)
        throw failure
      }
      const state = this.extractState(res.payload)
      ctx.emit({
        type: 'progress',
        taskId: request.id,
        provider: this.id,
        at: Date.now(),
        message: 'MAGI-2 ' + state + '（已等 ' + Math.round((Date.now() - started) / 1000) + 's）',
        data: { remoteTaskId: taskId, state, mode },
      })
      if (state === 'succeeded') {
        return { state, url: this.extractUrl(res.payload), raw: res.payload }
      }
      if (state === 'failed' || state === 'cancelled') {
        const err = (res.payload['error'] ?? {}) as Record<string, unknown>
        return {
          state,
          error: String(err['message'] ?? res.payload['message'] ?? '官方未给出原因'),
          code: String(err['code'] ?? ''),
          raw: res.payload,
        }
      }
      await sleep(interval, ctx.signal)
      interval = Math.min(Math.round(interval * 1.5), 15_000)
    }
  }

  /* ── 执行 ─────────────────────────────────────────────────── */

  async run(request: TaskRequest, ctx: RunContext): Promise<TaskResult> {
    const started = Date.now()
    const params = request.params
    const spec = this.specFromParams(params, request.inputs)
    const explicit = typeof params['mode'] === 'string' ? String(params['mode']) : undefined
    const mode = pickMagi2Mode(spec, explicit)
    if (spec.prompt === '') throw new ForgeError('prompt 不能为空', false)
    validateMagi2Spec(spec, mode)
    const body = await this.prepareBody(spec, mode, ctx)

    if (ctx.dryRun) {
      return {
        ok: true,
        taskId: request.id,
        provider: this.id,
        artifacts: [],
        seconds: 0,
        cached: false,
        warnings: ['dry-run：未发起请求'],
        wouldCall: {
          url: this.urlOf(mode === 'ark' ? ARK_PATH : NATIVE_PATH),
          mode,
          body: mode === 'ark' ? { ...body, content: (body['content'] as unknown[]).length + ' 条 content' } : body,
        },
      }
    }

    const submitPath = mode === 'ark' ? ARK_PATH : NATIVE_PATH
    const created = await this.request('POST', submitPath, body, 180_000, ctx.signal)
    if (created.status < 200 || created.status >= 300) {
      const failure = classifySandFailure(created.status, created.payload, body)
      if (failure.code === PENDING_QUOTA_CODE) this.remember('pending_quota', failure.message, submitPath)
      else if (failure.code === 'invalid_key') this.remember('invalid_key', failure.message, submitPath)
      throw failure
    }
    this.remember('ready', '最近一次调用已受理（' + submitPath + '）', submitPath)

    const taskId = String(created.payload['id'] ?? created.payload['task_id'] ?? dig(created.payload, 'data.id') ?? '')
    if (taskId === '') {
      throw new ForgeError('Sand.ai 未返回任务 id：' + created.text.slice(0, 300), false)
    }
    ctx.emit({
      type: 'start',
      taskId: request.id,
      provider: this.id,
      at: Date.now(),
      message: 'MAGI-2 ' + mode + ' 任务已创建 ' + taskId,
      data: { remoteTaskId: taskId, mode },
    })

    const timeoutRaw = Number(params['timeoutMs'] ?? DEFAULT_TIMEOUT_MS)
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS
    const outcome = await this.poll(mode, taskId, ctx, request, timeoutMs)

    if (outcome.state !== 'succeeded' || outcome.url === undefined) {
      const detail = outcome.error ?? outcome.state
      return {
        ok: false,
        taskId: request.id,
        provider: this.id,
        artifacts: [],
        seconds: Math.round((Date.now() - started) / 100) / 10,
        cached: false,
        warnings: [],
        error: 'MAGI-2 任务' + outcome.state + '：' + detail,
        usage: { remoteTaskId: taskId, state: outcome.state, code: outcome.code, mode },
      }
    }

    const dl = await fetch(outcome.url, { signal: withSignal(ctx.signal, 300_000) })
    if (!dl.ok) throw new ForgeError('下载 MAGI-2 视频失败：HTTP ' + dl.status, true)
    const bytes = Buffer.from(await dl.arrayBuffer())
    const hasAudio = spec.generateAudio !== false
    const durationSec = typeof body['duration'] === 'number' ? Number(body['duration']) : undefined
    const artifact = ctx.save('magi2', 'magi2-' + mode + '-' + taskId + '.mp4', bytes, {
      id: request.id + '#video',
      kind: 'video',
      mime: 'video/mp4',
      durationSec,
      meta: {
        model: body['model'] ?? this.modelId(),
        mode,
        resolution: body['resolution'] ?? '1080p',
        aspectRatio: body['aspect_ratio'] ?? spec.aspectRatio ?? null,
        remoteTaskId: taskId,
        remoteUrl: outcome.url,
        // generateAudio=false 时官方返回无音轨 MP4：下游（Remotion/ffmpeg 混音）据此决定不取音轨，
        // 否则会因"流不存在"报错。
        hasAudio,
        audioNote: hasAudio ? 'generated' : 'generateAudio=false：成品无音轨（下游请自行配音）',
        prompt: spec.prompt.slice(0, 2000),
        fileKeyHint: artifactUrl('o/magi2/' + basename(outcome.url)),
      },
    })

    return {
      ok: true,
      taskId: request.id,
      provider: this.id,
      artifacts: [artifact],
      seconds: Math.round((Date.now() - started) / 100) / 10,
      cached: false,
      warnings: hasAudio ? [] : ['generateAudio=false：产物为无音轨 MP4（meta.hasAudio=false）'],
      usage: { ...(outcome.raw['usage'] as Record<string, unknown> ?? {}), remoteTaskId: taskId, mode },
    }
  }
}
