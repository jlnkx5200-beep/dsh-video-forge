/**
 * MAGI-2（Sand.ai 官方直连）请求体组装 —— 纯函数，零网络、零 IO。
 *
 * 为什么单独一个文件：官方对**序列化**有硬性洁癖，一旦多塞字段就是 400，
 * 而这类规则必须能被单元测试逐条钉住（scripts/tests/magi2-payload.mjs），
 * 不能藏在 `class Magi2Provider` 的私有方法里只能靠真机碰运气验证。
 *
 * 官方两套端点，序列化规则**不同**，故意写在一起便于对照：
 *
 * ① Native（`POST /v2/generations`）—— 通用多模态参考
 *    · 多参考按类型分组（images / videos / audios），**没有** `role` 概念；
 *      塞 `role` 会被当成未知字段拒绝，故本文件在 Native 模式下**永不**产出 `role`。
 *    · `watermark` 一律不传（连 `false` 都不传：官方把"出现该键"当显式意图，反而校验失败）。
 *    · 未使用的可选字段必须**整个省略**，不能传 `null` / `""` / `[]`。
 *    · `resolution` 只接受 `"1080p"`，其它值省略；`aspect_ratio` 只接受 6 个枚举值。
 *    · `duration` 是 4–30 的**整数秒**。
 *
 * ② Ark 兼容首尾帧（`POST /compatible/ark/api/v3/contents/generations/tasks`）
 *    · 走 Ark 的 content[] 形态，首/尾帧**必须**用 `role` 区分（该端点官方 schema 要求，
 *      与 Native 的"无 role"并不矛盾：两套 API 的字段表本就不同）。
 *    · 一旦走这条端点，就**禁止**再混入通用多参考（首尾帧语义与多参考语义互斥）。
 *    · `watermark` 同样一律不传。
 */
import { ForgeError, PENDING_QUOTA_CODE } from './types.js'

export const MAGI2_DEFAULT_MODEL = 'magi-2'
export const MAGI2_DEFAULT_DURATION = 8
/** 官方只认这一个分辨率档；720p/2K 等值不要臆造。 */
export const MAGI2_RESOLUTIONS = ['1080p'] as const
export const MAGI2_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const

/** 官方硬上限（多参考不加价，但数量与总时长有天花板）。 */
export const MAGI2_LIMITS = {
  images: 10,
  videos: 5,
  audios: 5,
  videoSeconds: 30,
  audioSeconds: 30,
  media: 20,
  minDurationSec: 4,
  maxDurationSec: 30,
} as const

/** 任何模式下都不允许出现在请求体里的字段（出现即是我们自己的 bug）。 */
export const MAGI2_FORBIDDEN_FIELDS = ['watermark'] as const
/** 只允许 Ark 兼容端点出现的字段（Native 端点出现即报错）。 */
export const MAGI2_ARK_ONLY_FIELDS = ['role'] as const

export type Magi2Mode = 'native' | 'ark'

export interface Magi2Media {
  /** 官方资产 id（十进制字符串，大整数安全） */
  assetId: string
}

export interface Magi2TimelineCue {
  /** 该提示词生效的起始秒（整数或 .5 步进，官方按时间轴切片） */
  atSec: number
  prompt: string
}

/** 中立的镜头级规格 —— 与官方请求体解耦，两种模式下各自序列化。 */
export interface Magi2Spec {
  prompt: string
  model?: string
  /** 4–30 整数秒 */
  durationSec?: number
  /** 只接受 '1080p' */
  resolution?: string
  aspectRatio?: string
  seed?: number
  negativePrompt?: string
  images?: string[]
  videos?: string[]
  audios?: string[]
  /** 参考视频/音频的累计时长（秒），用于本地预校验上限 */
  videoSeconds?: number
  audioSeconds?: number
  firstFrame?: string
  lastFrame?: string
  timelineCues?: Magi2TimelineCue[]
  generateAudio?: boolean
  /** 视频编辑（对给定 video 资产做指令式编辑，而非生成） */
  edit?: boolean
}

const has = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)

/** 官方对整数 id 的处理必须大整数安全：14 位以上一律转字符串（Number 会丢精度）。 */
export function normalizeAssetId(input: unknown): string {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed !== '') return trimmed
    throw new ForgeError('资产 id 为空：上传接口没有返回可用 id', false)
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new ForgeError('资产 id 非法：' + String(input), false)
    // Number.isSafeInteger 为 false 说明已经丢过精度，宁可报错也不要悄悄传个错 id。
    if (!Number.isSafeInteger(input)) {
      throw new ForgeError('资产 id 超出安全整数范围（' + input + '）：必须按十进制字符串传递', false)
    }
    return String(input)
  }
  if (typeof input === 'bigint') return input.toString(10)
  if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const key of ['id', 'asset_id', 'assetId']) {
      if (has(obj[key])) return normalizeAssetId(obj[key])
    }
  }
  throw new ForgeError('资产 id 缺失或类型非法：' + JSON.stringify(input)?.slice(0, 200), false)
}

/**
 * 大整数安全的 JSON 解析：先把 `"id": 123456789012345678` 这类裸整数引号化，再 JSON.parse。
 * 直接用 JSON.parse 会把 19 位 id 变成 123456789012345680（末位被浮点吃掉）。
 */
export function parseJsonBigIntSafe(text: string): Record<string, unknown> {
  const guarded = text.replace(/("(?:id|asset_id|assetId|task_id)"\s*:\s*)(-?\d{15,})/g, '$1"$2"')
  try {
    const parsed = JSON.parse(guarded) as unknown
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new ForgeError('Sand.ai 返回非 JSON：' + text.slice(0, 300), false)
  }
}

/** 去掉所有 undefined / null / '' / [] —— 官方"未使用字段必须省略"。 */
export function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!has(value)) continue
    out[key] = value
  }
  return out
}

function clampDuration(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  return Math.min(MAGI2_LIMITS.maxDurationSec, Math.max(MAGI2_LIMITS.minDurationSec, rounded))
}

function resolveAspect(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const wanted = value.trim()
  if (wanted === 'auto' || wanted === 'adaptive') return undefined
  if (!(MAGI2_ASPECT_RATIOS as readonly string[]).includes(wanted)) {
    throw new ForgeError('aspectRatio 只能是 ' + MAGI2_ASPECT_RATIOS.join(' / ') + '，收到 ' + wanted, false)
  }
  return wanted
}

function resolveResolution(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const wanted = value.trim().toLowerCase()
  if (wanted === 'auto' || wanted === 'default') return undefined
  if (!(MAGI2_RESOLUTIONS as readonly string[]).includes(wanted)) {
    throw new ForgeError('resolution 只支持 "1080p" 或省略，收到 ' + value, false)
  }
  return wanted
}

/** 首尾帧一旦出现就必须整条走 Ark 兼容端点；多参考与首尾帧互斥。 */
export function pickMagi2Mode(spec: Pick<Magi2Spec, 'firstFrame' | 'lastFrame'>, explicit?: string): Magi2Mode {
  const wantsFrames = has(spec.firstFrame) || has(spec.lastFrame)
  if (explicit === 'ark') return 'ark'
  if (explicit === 'native' && wantsFrames) {
    throw new ForgeError('指定了 firstFrame/lastFrame 却又强制 native 端点：首尾帧只能走 Ark 兼容端点', false)
  }
  if (explicit === 'native') return 'native'
  return wantsFrames ? 'ark' : 'native'
}

/** 上限校验（在发请求之前就把话说清楚，别让官方 400 里的一行单词去猜）。 */
export function validateMagi2Spec(spec: Magi2Spec, mode: Magi2Mode): void {
  if (typeof spec.prompt !== 'string' || spec.prompt.trim() === '') {
    throw new ForgeError('prompt 不能为空', false)
  }
  const images = spec.images ?? []
  const videos = spec.videos ?? []
  const audios = spec.audios ?? []
  if (images.length > MAGI2_LIMITS.images) throw new ForgeError('参考图最多 ' + MAGI2_LIMITS.images + ' 张', false)
  if (videos.length > MAGI2_LIMITS.videos) throw new ForgeError('参考视频最多 ' + MAGI2_LIMITS.videos + ' 段', false)
  if (audios.length > MAGI2_LIMITS.audios) throw new ForgeError('参考音频最多 ' + MAGI2_LIMITS.audios + ' 段', false)
  const mediaCount = images.length + videos.length + audios.length + (has(spec.firstFrame) ? 1 : 0) + (has(spec.lastFrame) ? 1 : 0)
  if (mediaCount > MAGI2_LIMITS.media) throw new ForgeError('媒体总数最多 ' + MAGI2_LIMITS.media + ' 个（当前 ' + mediaCount + '）', false)
  if (spec.videoSeconds !== undefined && spec.videoSeconds > MAGI2_LIMITS.videoSeconds) {
    throw new ForgeError('参考视频总时长不得超过 ' + MAGI2_LIMITS.videoSeconds + 's（当前 ' + spec.videoSeconds + 's）', false)
  }
  if (spec.audioSeconds !== undefined && spec.audioSeconds > MAGI2_LIMITS.audioSeconds) {
    throw new ForgeError('参考音频总时长不得超过 ' + MAGI2_LIMITS.audioSeconds + 's（当前 ' + spec.audioSeconds + 's）', false)
  }
  if (spec.lastFrame !== undefined && spec.lastFrame !== '' && (spec.firstFrame === undefined || spec.firstFrame === '')) {
    throw new ForgeError('lastFrame 必须与 firstFrame 同时提供（官方限制）', false)
  }
  if (mode === 'ark' && (images.length > 0 || videos.length > 0 || audios.length > 0)) {
    throw new ForgeError('首尾帧（Ark 兼容端点）与通用多参考互斥：一次只能用一种', false)
  }
  if (spec.timelineCues !== undefined) {
    for (const cue of spec.timelineCues) {
      if (!Number.isFinite(cue.atSec) || cue.atSec < 0) throw new ForgeError('timelineCues.atSec 必须是非负数', false)
      if (typeof cue.prompt !== 'string' || cue.prompt.trim() === '') throw new ForgeError('timelineCues.prompt 不能为空', false)
    }
  }
}

function mediaList(kind: 'image' | 'video' | 'audio', refs: string[] | undefined): Array<Record<string, unknown>> | undefined {
  if (refs === undefined || refs.length === 0) return undefined
  // 注意：这里**故意**不写 role —— Native 端点按类型分组，多一个 role 就是未知字段。
  // 本地文件先换成官方资产 id；已是 http(s)/data: 的公网引用则原样按 url 传（官方两种都收）。
  return refs.map((ref) => {
    const value = String(ref).trim()
    if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return { url: value, kind }
    return { asset_id: normalizeAssetId(value), kind }
  })
}

/** Native 请求体（`POST /v2/generations`）。 */
export function buildNativeBody(spec: Magi2Spec, defaults: { model?: string; durationSec?: number } = {}): Record<string, unknown> {
  validateMagi2Spec(spec, 'native')
  const body = compact({
    model: spec.model ?? defaults.model ?? MAGI2_DEFAULT_MODEL,
    prompt: spec.prompt.trim(),
    duration: clampDuration(spec.durationSec, defaults.durationSec ?? MAGI2_DEFAULT_DURATION),
    resolution: resolveResolution(spec.resolution),
    aspect_ratio: resolveAspect(spec.aspectRatio),
    seed: typeof spec.seed === 'number' && Number.isFinite(spec.seed) ? Math.floor(spec.seed) : undefined,
    negative_prompt: spec.negativePrompt?.trim(),
    // 多参考：按类型分组，无 role。
    images: mediaList('image', spec.images),
    videos: mediaList('video', spec.videos),
    audios: mediaList('audio', spec.audios),
    timeline_cues: spec.timelineCues?.length
      ? spec.timelineCues.map(cue => ({ at: Math.round(cue.atSec * 10) / 10, prompt: cue.prompt.trim() }))
      : undefined,
    generate_audio: spec.generateAudio === undefined ? undefined : spec.generateAudio === true,
    edit: spec.edit === true ? true : undefined,
  })
  assertNoForbiddenFields(body, 'native')
  return body
}

/** Ark 兼容首尾帧请求体（`POST /compatible/ark/api/v3/contents/generations/tasks`）。 */
export function buildArkBody(spec: Magi2Spec, defaults: { model?: string; durationSec?: number } = {}): Record<string, unknown> {
  validateMagi2Spec(spec, 'ark')
  const text = String(spec.prompt).trim()
  const commands: string[] = []
  const resolution = resolveResolution(spec.resolution)
  if (resolution !== undefined) commands.push('--resolution ' + resolution)
  commands.push('--duration ' + clampDuration(spec.durationSec, defaults.durationSec ?? MAGI2_DEFAULT_DURATION))
  const aspect = resolveAspect(spec.aspectRatio)
  if (aspect !== undefined) commands.push('--ratio ' + aspect)
  if (typeof spec.seed === 'number' && Number.isFinite(spec.seed)) commands.push('--seed ' + Math.floor(spec.seed))

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: text + ' ' + commands.join(' ') }]
  if (has(spec.firstFrame)) {
    // 该端点官方 schema 用 role 区分首尾帧 —— 与 Native 的"无 role"是两套 API 的差异，不是笔误。
    content.push({ type: 'image_url', image_url: { url: spec.firstFrame }, role: 'first_frame' })
  }
  if (has(spec.lastFrame)) {
    content.push({ type: 'image_url', image_url: { url: spec.lastFrame }, role: 'last_frame' })
  }
  const body = compact({
    model: spec.model ?? defaults.model ?? MAGI2_DEFAULT_MODEL,
    content,
    generate_audio: spec.generateAudio === undefined ? undefined : spec.generateAudio === true,
  })
  // Ark 端点的 role 属于官方 schema（首/尾帧判定），只禁 Watermark。
  assertNoForbiddenFields(body, 'ark')
  return body
}

/**
 * 序列化兜底：任何模式下 `watermark` 都不许出现；Native 模式下 `role` 也不许出现。
 * 测试与 provider 都调这个函数，避免"某天有人顺手加了个字段"。
 */
export function assertNoForbiddenFields(body: Record<string, unknown>, mode: Magi2Mode): void {
  for (const field of MAGI2_FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      throw new ForgeError('请求体不允许包含 ' + field + ' 字段（官方硬性要求：连 false 都不传）', false)
    }
  }
  if (mode !== 'native') return
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path + '[' + index + ']'))
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'role') {
        throw new ForgeError('Native 请求体不允许包含 role 字段（位置 ' + path + '.' + key + '）', false)
      }
      walk(child, path + '.' + key)
    }
  }
  walk(body, '$')
}

/**
 * 官方错误 → 语义化异常。
 * `400 insufficient_credits` 不是"失败"，而是"已鉴权·待配额"：调用方必须能把它和 429/500 区分开。
 */
export function classifySandFailure(status: number, payload: Record<string, unknown>, snapshot?: Record<string, unknown>): ForgeError {
  const err = (payload['error'] ?? payload) as Record<string, unknown>
  const code = String(err['code'] ?? err['type'] ?? payload['code'] ?? '')
  const message = String(err['message'] ?? payload['message'] ?? JSON.stringify(payload).slice(0, 300))
  const detail: Record<string, unknown> = { httpStatus: status, code, ...(snapshot === undefined ? {} : { requestSnapshot: snapshot }) }

  if (status === 401 || status === 403 || /invalid_api_key|unauthorized|invalid.*key/i.test(code + ' ' + message)) {
    return new ForgeError('Sand.ai 鉴权失败（' + status + '）：' + message + '\n→ 检查 SAND_API_KEY 是否为官方账号直连 Key（本站不接任何第三方聚合网关）', false, detail, 'invalid_key')
  }
  if (status === 400 && /insufficient_credits|insufficient.?quota|no.?credits|quota/i.test(code + ' ' + message)) {
    return new ForgeError(
      'Sand.ai 官方配额未下发（400 insufficient_credits）：Key 鉴权已通过，等待官方配额下发后无需改代码即可生成。\n→ 可先「改用 MiniMax H3 生成」，或配额到位后一键重放本次参数。',
      false,
      detail,
      PENDING_QUOTA_CODE,
    )
  }
  if (status === 402 || /payment|balance/i.test(code)) {
    return new ForgeError('Sand.ai 余额/额度不可用（' + status + '）：' + message, false, detail, 'no_credits')
  }
  if (status === 429) return new ForgeError('Sand.ai 限流（429）：' + message, true, detail, 'rate_limited')
  if (status === 404) return new ForgeError('Sand.ai 端点不存在（404）：' + message, false, detail, 'not_found')
  if (status === 422 || status === 400) return new ForgeError('Sand.ai 参数不合法（' + status + '）：' + message, false, detail, 'bad_request')
  return new ForgeError('Sand.ai 报错（' + status + ' / ' + code + '）：' + message, status >= 500, detail, code || 'unknown')
}
