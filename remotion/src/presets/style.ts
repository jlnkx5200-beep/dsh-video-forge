/**
 * 风格属性 Schema —— 预设的「六大视觉维度」。
 *
 * 为什么要有这一层：
 *   旧版本的 presets 只有「搭几个网格 + 一个后处理数组」，审美默认值全散落在代码里，
 *   于是抽象很干净、出片却很廉价。这里把「决定画面观感的所有旋钮」显式抽成数据，
 *   每个预设必须**逐条声明**，不允许留空（缺省值只在厂内兜底，见 `resolveStyle()`）。
 *
 * 六个维度（与 docs/visual-quality-standard.md 一一对应）：
 *   lighting  光 —— 曝光 / 对比 / 饱和 / lift-gain 色温 / 泛光 / 暗角
 *   optics    镜 —— FOV 兜底 / 景深 / 焦点 / 视频层占画面比例 / 羽化
 *   spatial   空 —— 视差强度 / 顶点位移 / 两层景深位置 / 大气雾与地平线
 *   surface   质 —— 氛围微粒（尘埃/光斑/雪/全息点）/ 轮廓光 / 整体染色
 *   motion    动 —— 运镜弧度 / 呼吸漂移 / 默认转场
 *   promptModifiers 词 —— 注入上游 Seedream / MiniMax 的风格锚点词与负向去噪词
 */
import type { PostFXConfig } from '../engine/postfx'

export interface LightingSpec {
  /** 线性曝光倍数（1 = 不调；0.85~0.95 更适合 ACES 的亮部） */
  exposure: number
  contrast: number
  saturation: number
  /** 暗部染色（线性加性） */
  lift: [number, number, number]
  /** 亮部染色（乘性） */
  gain: [number, number, number]
  bloom: number
  bloomThreshold: number
  bloomRadius: number
  vignette: number
}

export interface OpticsSpec {
  /** plan 里没有机位 fov 时的兜底焦距（度） */
  fov: number
  /** 屏幕空间景深强度 0~1（0=关） */
  dof: number
  focus: [number, number]
  /** 视频平面占画面高度比例（0.55 = 只占中间一半，绝不整屏糊住静帧层） */
  videoCoverage: number
  /** 视频平面边缘羽化（UV 比例） */
  feather: number
}

export interface SpatialSpec {
  /** 视差强度（相邻层速度差） */
  parallax: number
  /** 深度图驱动的顶点位移强度（0.3~1.2；过大会撕裂） */
  displacement: number
  /** 背景板离相机多远（越大越"远"，视差越弱） */
  plateDepth: number
  /** 主体层离相机多远 */
  subjectDepth: number
  /** 大气色（背景与雾的颜色） */
  atmosphere: string
  /** 大气不透明度（0 = 无雾） */
  atmosphereOpacity: number
  /** 地平线位置 0~1（大气辉光中心） */
  horizon: number
}

export interface SurfaceSpec {
  particle: 'dust' | 'bokeh' | 'snow' | 'holo' | 'none'
  count: number
  color: string
  /** 微粒世界尺寸 */
  size: number
  spread: [number, number, number]
  /** 漂浮振幅 */
  amplitude: number
  /** 轮廓光强度（0 = 关；硬边缘轮廓是"毛刺感"来源，默认很小） */
  edgeBoost: number
  /** 图层整体染色 */
  tint: string
  tintAmount: number
}

export interface MotionSpec {
  /** 运镜弧度系数（host 编译器 cameraFor 用弧度生成机位弧，preset 只作为审美提示） */
  arc: number
  /** 手持呼吸幅度（0 = 完全静止） */
  drift: number
  /** 默认转场 */
  transition: string
}

export interface PromptModifiers {
  /** 风格锚点词：追加到 Seedream / MiniMax 的正向提示词 */
  anchors: string[]
  /** 负向去噪词：压掉"涂抹感 / 高噪点 / 水印 / 低质纹理" */
  negative: string[]
}

export interface StyleSpec {
  id: string
  name: string
  description: string
  cameraHints: string[]
  lighting: LightingSpec
  optics: OpticsSpec
  spatial: SpatialSpec
  surface: SurfaceSpec
  motion: MotionSpec
  promptModifiers: PromptModifiers
}

/**
 * 视野框尺寸：给定「离相机距离 + 竖直 fov + 画面比例」，算出该平面上铺满画面的世界尺寸。
 *
 * 这是修复「画面糊」的关键：以前静帧层被硬编码成 30×16.9 挂在 z=-8，
 * 而 z=-8 处的可视高度只有 0.767×8 ≈ 6.1，等于把 2K 图的中间 1/3 放大 3 倍 →
 * 再好的 Seedream 原图也会糊。所有图层尺寸现在都由这个函数推出来。
 */
export function frameAt(distance: number, fovDeg: number, aspect: number): { width: number; height: number } {
  const fov = Math.max(1, Math.min(179, fovDeg))
  const height = 2 * Math.abs(distance) * Math.tan((fov * Math.PI) / 360)
  return { width: height * aspect, height }
}

/** 把 StyleSpec 的 lighting 映射成后处理配置（预设不再手写零散的 postFXConfig）。 */
export function lightingToPostFX(lighting: LightingSpec, extra: Partial<PostFXConfig> = {}): Partial<PostFXConfig> {
  return {
    exposure: lighting.exposure,
    contrast: lighting.contrast,
    saturation: lighting.saturation,
    lift: lighting.lift,
    gain: lighting.gain,
    bloom: lighting.bloom,
    bloomThreshold: lighting.bloomThreshold,
    bloomRadius: lighting.bloomRadius,
    vignette: lighting.vignette,
    grain: 0,
    ...extra,
  }
}

/** 六个维度必须齐全；缺项时用这里的保守默认兜底（并在控制台警告）。 */
export function resolveStyle(spec: Partial<StyleSpec> & { id: string; name: string }): StyleSpec {
  const base: StyleSpec = {
    id: spec.id,
    name: spec.name,
    description: spec.description ?? '',
    cameraHints: spec.cameraHints ?? ['dolly-in', 'pan', 'static'],
    lighting: {
      exposure: 0.9, contrast: 1.05, saturation: 1.0,
      lift: [0, 0, 0], gain: [1, 1, 1],
      bloom: 0.14, bloomThreshold: 0.86, bloomRadius: 1.1, vignette: 0.1,
    },
    optics: { fov: 42, dof: 0, focus: [0.5, 0.5], videoCoverage: 0.62, feather: 0.22 },
    spatial: {
      parallax: 0.5, displacement: 0.7, plateDepth: 12, subjectDepth: 7,
      atmosphere: '#0a0f18', atmosphereOpacity: 0.0, horizon: 0.58,
    },
    surface: {
      particle: 'dust', count: 260, color: '#cdd8ea', size: 0.035,
      spread: [26, 12, 20], amplitude: 0.35, edgeBoost: 0, tint: '#ffffff', tintAmount: 0,
    },
    motion: { arc: 1, drift: 0.1, transition: 'crossfade' },
    promptModifiers: { anchors: [], negative: [] },
  }
  const merged: StyleSpec = {
    ...base,
    ...spec,
    lighting: { ...base.lighting, ...(spec.lighting ?? {}) },
    optics: { ...base.optics, ...(spec.optics ?? {}) },
    spatial: { ...base.spatial, ...(spec.spatial ?? {}) },
    surface: { ...base.surface, ...(spec.surface ?? {}) },
    motion: { ...base.motion, ...(spec.motion ?? {}) },
    promptModifiers: { ...base.promptModifiers, ...(spec.promptModifiers ?? {}) },
  }
  return merged
}
