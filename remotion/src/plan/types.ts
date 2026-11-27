/**
 * RenderPlan 类型镜像（Remotion 侧）。
 *
 * 与 host 侧 `src/bridge/render-plan.ts` 是**两份独立实现**：这里零 import，
 * 子工程能脱离宿主单独 `npx remotion studio`。一致性由 `fixtures/render-plan.example.json`
 * 的双向契约测试保证（双方各跑一遍解析）。改字段必须两边一起改。
 */

export interface CameraKeyframe {
  position: [number, number, number]
  lookAt: [number, number, number]
  roll?: number
}

export interface ShotCamera {
  move: string
  from: CameraKeyframe
  to: CameraKeyframe
  fov: number
  easing?: 'smooth' | 'linear' | 'easeInOut'
}

export type BlendMode = 'normal' | 'additive' | 'multiply' | 'lumaKey'

export interface ShotLayer {
  src: string
  depthSrc?: string
  matteSrc?: string
  parallax: number
  depth: number
}

export interface ShotVideo {
  src: string
  blend: BlendMode
  opacity: number
  chromaKey?: { color: string; similarity: number; smoothness: number }
  width?: number
  height?: number
}

export interface ShotTransition {
  type: string
  durationInFrames: number
  maskSrc?: string
  direction?: 'left' | 'right' | 'up' | 'down'
}

export interface ShotAssets {
  still?: string
  /** 背景板（主体剥离 + 周围像素修复），有它就别再把带主体的静帧当远景 */
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
  from: number
  durationInFrames: number
  /** 产线策略：seedream-static / still-3d / comfy-pipeline / minimax-direct / magi2-direct / magi2-i2v */
  strategy: string
  shotSize?: string
  description?: string
  camera: ShotCamera
  layer?: ShotLayer
  video?: ShotVideo
  postFX?: string[]
  transitionIn?: ShotTransition
  transitionOut?: ShotTransition
  caption?: string
  assets: ShotAssets
}

export interface PlanStyle {
  tags?: string[]
  palette?: string[]
  fogColor?: string
  background?: string
}

export interface PlanAudio {
  src: string
  volume?: number
  beats?: number[]
}

export interface RenderPlan {
  version: number
  id: string
  title: string
  width: number
  height: number
  fps: number
  durationInFrames: number
  preset: string
  style?: PlanStyle
  audio?: PlanAudio
  shots: ShotPlan[]
  provenance?: Record<string, unknown>
  createdAt?: string
}

export interface PlanIssue {
  level: 'error' | 'warn'
  shotId?: string
  message: string
}

export interface ParsedPlan {
  plan: RenderPlan
  issues: PlanIssue[]
}


/**
 * 视频类策略：镜头的画面主体是「一段真实视频」而不是「静帧 + 深度分层」。
 * MiniMax H3 与 MAGI-2 走同一条渲染路径（video plane / video-first 预设），
 * 因此渲染侧只需要判断"是不是视频镜头"，不需要知道是哪个 Provider 产的。
 */
export const VIDEO_STRATEGIES = ['minimax-direct', 'minimax-2k-repaint', 'magi2-direct', 'magi2-i2v'] as const

export function isVideoStrategy(strategy: string): boolean {
  return (VIDEO_STRATEGIES as readonly string[]).includes(strategy)
}
