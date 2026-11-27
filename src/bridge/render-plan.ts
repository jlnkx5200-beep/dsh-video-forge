/**
 * RenderPlan —— host 与 Remotion 渲染内核之间**唯一**的契约。
 *
 * 谁写它：host 侧 bridge/compiler.ts（或用户手写）。
 * 谁读它：remotion/src/plan/parse.ts（防御式镜像解析，零依赖，不 import 本文件）。
 *
 * 为什么不用共享 TS 包：remotion 子工程要能脱离宿主单独 `npx remotion studio` 跑，
 * 一旦跨目录 import 就会把它变成 monorepo 依赖。契约用**两份实现 + 一份夹具**保证一致：
 * 双方都跑 `fixtures/render-plan.example.json` 的解析测试。
 *
 * 风格无关原则：本文件只描述"镜头、时间、资产、运镜关键帧、后处理栈"，
 * 不含任何具体艺术风格名。风格只作为 preset 参数（style.tags / style.palette）透传。
 */

export type ShotStrategy =
  | 'seedream-static'
  | 'still-3d'
  | 'minimax-direct'
  /** H3 2K 重绘：静帧当首帧 + 2K 直出，兜住 768P 的锐度天花板 */
  | 'minimax-2k-repaint'
  | 'comfy-pipeline'
  /** MAGI-2 原生直出（T2V / 多模态参考 / 时间轴分镜 / 视频编辑）—— 走 Native 端点 */
  | 'magi2-direct'
  /** MAGI-2 图生视频（首帧/尾帧）—— 走 Ark 兼容端点 */
  | 'magi2-i2v'

export type BlendMode = 'normal' | 'additive' | 'multiply' | 'lumaKey'

export interface CameraKeyframe {
  /** 世界坐标（可只填 x/z，y 由 preset 决定） */
  position: [number, number, number]
  /** 注视点（LookAt 目标） */
  lookAt: [number, number, number]
  roll?: number
}

export interface ShotCamera {
  /** 运镜名：dolly-in / dolly-out / orbit / pan / crane-up / handheld / static */
  move: string
  from: CameraKeyframe
  to: CameraKeyframe
  fov: number
  /** 缓动：smooth（阻尼平滑，默认） / linear / easeInOut */
  easing?: 'smooth' | 'linear' | 'easeInOut'
}

export interface ShotLayer {
  /** 静帧贴图（走 /api/dsh-video-forge/file/... 或 remotion staticFile） */
  src: string
  /** 深度图（ComfyUI DshDepthEstimate 产出）；没有则按亮度近似 */
  depthSrc?: string
  /** 透明通道图（DshAlphaMatte 产出） */
  matteSrc?: string
  /** 视差强度（0 = 平面，1 = 强纵深） */
  parallax: number
  /** 图层在空间中的 z 偏移 */
  depth: number
}

export interface ShotVideo {
  src: string
  blend: BlendMode
  opacity: number
  /** 抠像参数（video 为绿幕/蓝幕合成结果时用） */
  chromaKey?: { color: string; similarity: number; smoothness: number }
  /** 视频映射到的平面宽度（世界单位） */
  width?: number
  height?: number
}

export interface ShotPostFX {
  /** 已注册的 pass 名：bloom / dof / grade / grain / vignette / edge / dissolve */
  name: string
  params: Record<string, number | string | boolean>
}

export interface ShotTransition {
  /** 转场类型：crossfade / radial-blur / luma-wipe / noise-dissolve / push */
  type: string
  durationInFrames: number
  /** 遮罩图（luma-wipe / noise-dissolve 用） */
  maskSrc?: string
  direction?: 'left' | 'right' | 'up' | 'down'
}

export interface ShotAssets {
  still?: string
  /** 背景板：主体被剥离、洞口用周围像素延展修复后的整幅背景（2.5D 防撕裂的关键） */
  plate?: string
  depth?: string
  matte?: string
  normal?: string
  video?: string
  transitionMask?: string
}

export interface ShotPlan {
  id: string
  index: number
  /** 时间轴起点（帧） */
  from: number
  durationInFrames: number
  /** 生成策略（写入 plan 便于复盘：这个镜头是怎么来的） */
  strategy: ShotStrategy
  /** 镜别：wide / medium / close-up / macro / insert（仅描述用，渲染内核不关心） */
  shotSize?: string
  /** 画面内容描述（人读） */
  description?: string
  camera: ShotCamera
  layer?: ShotLayer
  video?: ShotVideo
  postFX: ShotPostFX[]
  transitionIn?: ShotTransition
  transitionOut?: ShotTransition
  /** 字幕/旁白（可选） */
  caption?: string
  assets: ShotAssets
}

export interface RenderPlanAudio {
  src?: string
  volume?: number
  /** 节拍点（帧），video-shotcraft 的 beat sync 产物可直填 */
  beats?: number[]
}

export interface RenderPlanStyle {
  /** 风格标签（自由文本，仅透传给 preset 做参数化，不参与任何分支判断） */
  tags: string[]
  /** 主色板（#rrggbb） */
  palette: string[]
  /** 雾色 / 背景色 */
  fogColor?: string
  background?: string
}

export interface RenderPlan {
  version: 1
  id: string
  title: string
  width: number
  height: number
  fps: number
  durationInFrames: number
  /** 渲染预设名（remotion/src/presets/ 下注册的 key） */
  preset: string
  style: RenderPlanStyle
  audio?: RenderPlanAudio
  shots: ShotPlan[]
  /** 生成溯源：谁/什么参数产出的这份 plan */
  provenance?: Record<string, unknown>
  createdAt: string
}

export interface PlanIssue {
  level: 'error' | 'warn'
  shotId?: string
  message: string
}

/** 结构性校验：时间轴连续、时长>0、必填字段齐、素材路径存在（后者由调用方决定是否检查）。 */
export function validatePlan(plan: RenderPlan): PlanIssue[] {
  const issues: PlanIssue[] = []
  if (plan.version !== 1) issues.push({ level: 'error', message: 'version 必须为 1' })
  if (!(plan.width > 0) || !(plan.height > 0)) issues.push({ level: 'error', message: 'width/height 必须为正数' })
  if (!(plan.fps > 0)) issues.push({ level: 'error', message: 'fps 必须为正数' })
  if (plan.shots.length === 0) issues.push({ level: 'error', message: 'shots 不能为空' })

  const sorted = [...plan.shots].sort((a, b) => a.from - b.from)
  let cursor = 0
  for (const [i, shot] of sorted.entries()) {
    if (shot.durationInFrames <= 0) issues.push({ level: 'error', shotId: shot.id, message: 'durationInFrames 必须 > 0' })
    if (shot.from !== cursor) {
      issues.push({ level: 'warn', shotId: shot.id, message: '时间轴不连续：期望 from=' + cursor + '，实际 ' + shot.from })
    }
    cursor = shot.from + shot.durationInFrames
    if (shot.camera.from.position.length !== 3 || shot.camera.to.position.length !== 3) {
      issues.push({ level: 'error', shotId: shot.id, message: 'camera.from/to.position 必须是 3 元组' })
    }
    if (shot.camera.fov <= 0 || shot.camera.fov >= 180) {
      issues.push({ level: 'error', shotId: shot.id, message: 'camera.fov 必须在 (0,180)' })
    }
    const hasLayer = shot.layer !== undefined
    const hasVideo = shot.video !== undefined
    if (!hasLayer && !hasVideo) issues.push({ level: 'error', shotId: shot.id, message: 'layer 与 video 至少要有一个' })
    if (hasLayer && shot.layer!.src.trim() === '') issues.push({ level: 'error', shotId: shot.id, message: 'layer.src 不能为空' })
    if (hasVideo && shot.video!.src.trim() === '') issues.push({ level: 'error', shotId: shot.id, message: 'video.src 不能为空' })
    if (shot.transitionIn !== undefined && shot.transitionIn.durationInFrames > shot.durationInFrames) {
      issues.push({ level: 'warn', shotId: shot.id, message: 'transitionIn 时长超过镜头时长' })
    }
    if (i === 0 && shot.transitionIn !== undefined) {
      issues.push({ level: 'warn', shotId: shot.id, message: '首个镜头不需要入转场' })
    }
  }
  if (cursor !== plan.durationInFrames) {
    issues.push({ level: 'warn', message: 'durationInFrames(' + plan.durationInFrames + ') 与镜头总长(' + cursor + ') 不一致' })
  }
  return issues
}

/** 时间轴工具：按秒时长列表生成 from/durationInFrames（确定性，无 Date/随机）。 */
export function layoutDurations(durationsSec: number[], fps: number): Array<{ from: number; durationInFrames: number }> {
  const out: Array<{ from: number; durationInFrames: number }> = []
  let cursor = 0
  for (const sec of durationsSec) {
    const frames = Math.max(1, Math.round(sec * fps))
    out.push({ from: cursor, durationInFrames: frames })
    cursor += frames
  }
  return out
}
