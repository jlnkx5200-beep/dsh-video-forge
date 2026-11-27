/**
 * MAGI-2 请求体「消毒器」（P2-8 被测对象之一，浏览器侧纯函数）。
 *
 * 它不负责发请求——它只回答一个问题：**这一版参数实际会以什么形状发出去**。
 * 面板把它的结果直接渲染给用户看，把 Sand.ai 官方契约里的硬性红线变成肉眼可见的东西：
 *   · 绝不出现 watermark（连 false 都不传）
 *   · 绝不出现 role
 *   · 未使用的可选字段直接 omit，不传 null
 *   · resolution 只能是 "1080p" 或省略
 *   · aspectRatio 只能是 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16
 *   · 图片 ≤10、视频 ≤5 且总长 ≤30s、音频 ≤5 且总长 ≤30s、媒体总数 ≤20
 *   · 时长必须是 4–30 的整数
 *   · 大整数 assetId 一律按十进制字符串处理（JS number 会丢精度）
 */

export const MAGI2_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const
export const MAGI2_FORBIDDEN_FIELDS = ['watermark', 'role'] as const
export const MAGI2_LIMITS = { images: 10, videos: 5, audios: 5, mediaTotal: 20, videoSeconds: 30, audioSeconds: 30, minDuration: 4, maxDuration: 30 } as const

export type Magi2Mode = 'native' | 'ark'

export interface SanitizeInput {
  prompt?: string
  negativePrompt?: string
  aspectRatio?: string
  resolution?: string
  duration?: number
  generateAudio?: boolean
  seed?: number
  model?: string
  firstFrame?: string
  lastFrame?: string
  referenceImages?: string[]
  referenceVideos?: Array<string | { url?: string; assetId?: string; seconds?: number }>
  referenceAudios?: Array<{ url?: string; assetId?: string; seconds?: number }>
  timelineCues?: Array<{ atSec: number; prompt: string }>
  /** 任何想混进来的非法字段（演示/测试用） */
  extra?: Record<string, unknown>
}

export interface SanitizeResult {
  mode: Magi2Mode
  payload: Record<string, unknown>
  issues: Array<{ level: 'error' | 'warn'; message: string }>
  stripped: string[]
}

function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** 大整数安全：≥15 位纯数字一律转字符串（Sand.ai asset id 是 int64）。 */
export function normalizeAssetId(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('assetId 超出 JS 安全整数范围，必须以字符串传递：' + String(value))
    }
    return String(value)
  }
  return value.trim()
}

function secondsOf(item: string | { seconds?: number }): number {
  return typeof item === 'object' && typeof item.seconds === 'number' ? item.seconds : 0
}

/** 首尾帧 → Ark 兼容端点；否则 → Native 端点。混传是硬错误。 */
export function pickMode(input: SanitizeInput): Magi2Mode {
  return isFilled(input.firstFrame) || isFilled(input.lastFrame) ? 'ark' : 'native'
}

export function sanitizeMagi2Payload(input: SanitizeInput): SanitizeResult {
  const issues: SanitizeResult['issues'] = []
  const stripped: string[] = []
  const mode = pickMode(input)

  const images = (input.referenceImages ?? []).filter(item => isFilled(item))
  const videos = (input.referenceVideos ?? []).filter(item => isFilled(item))
  const audios = (input.referenceAudios ?? []).filter(item => isFilled(item))
  const hasFrames = isFilled(input.firstFrame) || isFilled(input.lastFrame)

  if (hasFrames && (images.length > 0 || videos.length > 0 || audios.length > 0)) {
    issues.push({ level: 'error', message: '首尾帧（firstFrame/lastFrame）与多模态参考不能混传：首尾帧走 Ark 兼容端点，多参考走 Native 端点，请二选一。' })
  }
  if (images.length > MAGI2_LIMITS.images) issues.push({ level: 'error', message: '参考图最多 10 张，当前 ' + images.length + ' 张。' })
  if (videos.length > MAGI2_LIMITS.videos) issues.push({ level: 'error', message: '参考视频最多 5 段，当前 ' + videos.length + ' 段。' })
  if (audios.length > MAGI2_LIMITS.audios) issues.push({ level: 'error', message: '参考音频最多 5 段，当前 ' + audios.length + ' 段。' })
  const videoSeconds = videos.reduce((sum, item) => sum + secondsOf(item), 0)
  const audioSeconds = audios.reduce((sum, item) => sum + secondsOf(item), 0)
  if (videoSeconds > MAGI2_LIMITS.videoSeconds) issues.push({ level: 'error', message: '参考视频总长超限：' + videoSeconds + 's > 30s。' })
  if (audioSeconds > MAGI2_LIMITS.audioSeconds) issues.push({ level: 'error', message: '参考音频总长超限：' + audioSeconds + 's > 30s。' })
  if (images.length + videos.length + audios.length > MAGI2_LIMITS.mediaTotal) {
    issues.push({ level: 'error', message: '媒体总数最多 20 路，当前 ' + (images.length + videos.length + audios.length) + ' 路。' })
  }

  const payload: Record<string, unknown> = {}
  if (isFilled(input.prompt)) payload['prompt'] = String(input.prompt).trim()
  if (isFilled(input.model)) payload['model'] = input.model

  const rawDuration = typeof input.duration === 'number' ? input.duration : Number.NaN
  if (Number.isFinite(rawDuration)) {
    const duration = Math.round(rawDuration)
    if (duration < MAGI2_LIMITS.minDuration || duration > MAGI2_LIMITS.maxDuration) {
      issues.push({ level: 'error', message: '时长必须是 4–30 的整数秒，当前 ' + rawDuration + '。' })
    }
    payload['duration'] = Math.min(MAGI2_LIMITS.maxDuration, Math.max(MAGI2_LIMITS.minDuration, duration))
  }

  // resolution：只允许 "1080p"；其它值一律省略并在 UI 上提示，而不是偷偷改写
  if (isFilled(input.resolution)) {
    if (input.resolution === '1080p') payload['resolution'] = '1080p'
    else issues.push({ level: 'warn', message: 'resolution 仅支持 "1080p"，已省略（MAGI-2 原生 1080p）。' })
  }

  if (isFilled(input.aspectRatio)) {
    if ((MAGI2_ASPECT_RATIOS as readonly string[]).includes(String(input.aspectRatio))) {
      payload['aspect_ratio'] = input.aspectRatio
    } else {
      issues.push({ level: 'error', message: 'aspectRatio 只允许 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16，当前 ' + String(input.aspectRatio) + '。' })
    }
  }

  if (typeof input.generateAudio === 'boolean') payload['generate_audio'] = input.generateAudio
  if (typeof input.seed === 'number' && Number.isFinite(input.seed)) payload['seed'] = Math.trunc(input.seed)

  if (hasFrames) {
    if (isFilled(input.firstFrame)) payload['first_frame'] = { asset_id: normalizeAssetId(String(input.firstFrame)) }
    if (isFilled(input.lastFrame)) payload['last_frame'] = { asset_id: normalizeAssetId(String(input.lastFrame)) }
  } else {
    if (images.length > 0) payload['reference_images'] = images.map(item => ({ asset_id: normalizeAssetId(item) }))
    if (videos.length > 0) payload['reference_videos'] = videos.map(item => ({ asset_id: normalizeAssetId(typeof item === 'string' ? item : (item.assetId ?? item.url ?? '')) }))
    if (audios.length > 0) payload['reference_audios'] = audios.map(item => ({ asset_id: normalizeAssetId(item.assetId ?? item.url ?? '') }))
  }

  if (Array.isArray(input.timelineCues) && input.timelineCues.length > 0) {
    payload['timeline_cues'] = input.timelineCues
      .filter(cue => Number.isFinite(cue.atSec) && isFilled(cue.prompt))
      .map(cue => ({ at_sec: cue.atSec, prompt: cue.prompt }))
  }

  // 非法字段：显式剥掉并记录下来给用户看
  if (input.extra !== undefined) {
    for (const [key, value] of Object.entries(input.extra)) {
      if (!isFilled(value)) continue
      stripped.push(key)
      issues.push({ level: 'error', message: '字段「' + key + '」不属于 Sand.ai 官方契约，已丢弃（防止 400）。' })
    }
  }
  for (const field of MAGI2_FORBIDDEN_FIELDS) {
    if (field in payload) {
      delete payload[field]
      stripped.push(field)
    }
  }

  // 空值一律 omit（不是 null）
  for (const key of Object.keys(payload)) {
    if (payload[key] === null || payload[key] === undefined) delete payload[key]
  }

  return { mode, payload, issues, stripped }
}
