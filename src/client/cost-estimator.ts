/**
 * 成本估算器（P2-8 被测对象之一）。
 *
 * 官方单价会变，而且 MAGI-2 目前还在等配额下发，所以这里**不写死任何货币金额**，
 * 只给「相对成本指数」——同一套分镜在两个引擎上的相对开销，用来回答
 * 「这一版该用 H3 还是 MAGI-2」，而不是报一个会过期的价目表。
 *
 * 口径（1.0 = 一张 5.0-flash 静帧）：
 *   Seedream 静帧   5.0-flash 1.0 / 4.0 1.2 / 5.0-pro 2.0 / 5.5 2.5
 *   H3 视频（每秒）480P 0.6 / 768P 1.0 / 2K 1.8
 *   MAGI-2（每秒）原生 1080p 1.2，多参考 ≤20 路不加价
 *   ComfyUI 本地   每次 0.05（只算电费级开销）
 *   Mock / 缓存命中 0
 */

export type VideoEngine = 'minimax' | 'magi2' | 'none'

export interface EstimateInput {
  shots: number
  /** 每镜时长（秒），缺省 6 */
  secondsPerShot?: number
  strategy: string
  minimaxResolution?: string
  seedreamModel?: string
  /** 0 = 不用静帧（magi2-direct 纯文生视频） */
  imagesPerShot?: number
  comfyCallsPerShot?: number
  mock?: boolean
  useCache?: boolean
  magi2Duration?: number
  /** 多参考路数（MAGI-2 不加价，仅用于提示） */
  referenceCount?: number
}

export interface EstimateLine {
  label: string
  units: number
  detail: string
}

export interface Estimate {
  total: number
  lines: EstimateLine[]
  engine: VideoEngine
  videoSeconds: number
  /** 与另一个引擎的差值说明（正数 = 本方案更贵） */
  compare?: { alternative: VideoEngine; total: number; delta: number }
  notes: string[]
}

const IMAGE_UNITS: Record<string, number> = {
  '5.0-flash': 1,
  '4.0': 1.2,
  '5.0-pro': 2,
  '5.5': 2.5,
}

const MAXIM_SECONDS: Record<string, number> = {
  '480P': 0.6,
  '768P': 1,
  '2K': 1.8,
}

const MAGI2_PER_SECOND = 1.2

export function imageUnits(model: string | undefined): number {
  return IMAGE_UNITS[model ?? '5.0-flash'] ?? 1
}

export function minimaxSecondUnits(resolution: string | undefined): number {
  return MAXIM_SECONDS[(resolution ?? '768P').toUpperCase()] ?? 1
}

export function engineOf(strategy: string): VideoEngine {
  if (strategy === 'magi2-direct' || strategy === 'magi2-i2v') return 'magi2'
  if (strategy === 'minimax-direct' || strategy === 'minimax-2k-repaint' || strategy === 'comfy-pipeline') return 'minimax'
  return 'none'
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function estimate(input: EstimateInput): Estimate {
  const shots = Math.max(0, Math.floor(input.shots))
  const seconds = Math.max(1, input.secondsPerShot ?? 6)
  const engine = engineOf(input.strategy)
  const notes: string[] = []

  if (input.mock === true) {
    return { total: 0, lines: [{ label: 'Mock 占位', units: 0, detail: '本地合成 PNG/MP4，不调用任何付费接口' }], engine, videoSeconds: shots * seconds, notes: ['Mock 模式产物仅供占位，不可作为正式成片。'] }
  }

  const lines: EstimateLine[] = []
  const imagesPerShot = input.imagesPerShot ?? 1
  const imageTotal = shots * imagesPerShot * imageUnits(input.seedreamModel)
  if (imageTotal > 0) {
    lines.push({ label: 'Seedream 静帧', units: round(imageTotal), detail: shots + ' 镜 × ' + imagesPerShot + ' 张 × ' + imageUnits(input.seedreamModel) })
  }

  const comfyPerShot = input.comfyCallsPerShot ?? 0
  if (comfyPerShot > 0) {
    lines.push({ label: 'ComfyUI 本地加工', units: round(shots * comfyPerShot * 0.05), detail: shots + ' 镜 × ' + comfyPerShot + ' 次（本机 GPU，仅电费级）' })
  }

  const videoSeconds = engine === 'none' ? 0 : shots * (engine === 'magi2' ? Math.min(30, Math.max(4, Math.round(input.magi2Duration ?? seconds))) : seconds)
  if (engine === 'minimax') {
    const perSecond = minimaxSecondUnits(input.minimaxResolution)
    lines.push({ label: 'MiniMax H3 视频', units: round(videoSeconds * perSecond), detail: videoSeconds + 's × ' + perSecond + '/s（' + (input.minimaxResolution ?? '768P') + '）' })
  } else if (engine === 'magi2') {
    const perShot = Math.min(30, Math.max(4, Math.round(input.magi2Duration ?? seconds)))
    lines.push({ label: 'MAGI-2 视频', units: round(videoSeconds * MAGI2_PER_SECOND), detail: shots + ' 镜 × ' + perShot + 's（原生 1080p）' })
    if ((input.referenceCount ?? 0) > 0) notes.push('MAGI-2 多参考（≤20 路）不加价：已计入上面的每秒单价。')
    notes.push('MAGI-2 当前仍可能返回 pending_quota（已鉴权待配额）：该态不扣费，可留作草稿稍后一键重放。')
  }

  let total = lines.reduce((sum, line) => sum + line.units, 0)
  if (input.useCache === true) {
    notes.push('命中内容缓存的镜头为 0 成本：同 prompt/参数/参考图重复生成不会重复计费。')
    total = round(total * 0.85)
    lines.push({ label: '缓存折扣（估）', units: round(-total / 0.85 * 0.15), detail: '按约 15% 镜头命中缓存折算，仅作估算' })
  }

  return { total: round(total), lines, engine, videoSeconds, notes }
}

/** H3 vs MAGI-2 同分镜对照（费用问题的直接答案）。 */
export function compareEngines(input: EstimateInput): { minimax: Estimate; magi2: Estimate; cheaper: VideoEngine; delta: number } {
  const base: EstimateInput = { ...input, mock: false, useCache: false }
  const minimax = estimate({
    ...base,
    strategy: 'minimax-direct',
    // H3 不能超过 15s/镜：按 15s 上限估（分段生成时镜头数会翻倍，这里给保守值）
    secondsPerShot: Math.min(15, base.secondsPerShot ?? 6),
    minimaxResolution: base.minimaxResolution ?? '768P',
  })
  const magi2 = estimate({
    ...base,
    strategy: 'magi2-i2v',
    magi2Duration: Math.min(30, Math.max(4, Math.round(base.secondsPerShot ?? 6))),
    secondsPerShot: Math.min(30, Math.max(4, Math.round(base.secondsPerShot ?? 6))),
  })
  const delta = round(magi2.total - minimax.total)
  return { minimax, magi2, cheaper: delta <= 0 ? 'magi2' : 'minimax', delta }
}
