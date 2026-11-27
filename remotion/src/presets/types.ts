import type { ReactNode } from 'react'
import type { PostFXConfig } from '../engine/postfx'
import type { MaterialStyleSelection } from '../engine/ComposablePostFX'
import type { RenderPlan, ShotPlan } from '../plan/types'

export interface PresetBuildContext {
  plan: RenderPlan
  shot: ShotPlan
  materialStyle: MaterialStyleSelection
  preset: StagePreset
}

export interface PresetBackgroundContext {
  plan: RenderPlan
  shot: ShotPlan
}

export interface PresetPostFXContext {
  plan: RenderPlan
  shot: ShotPlan
}

/**
 * 一个有可执行视觉主张的舞台预设。
 * 内核只调用这三个钩子，其它一切（几何、材质、灯光、灯光强度）都在预设内部决定。
 */
export interface StagePreset {
  id: string
  /** 人读的名字 */
  name: string
  description: string
  /** 这个预设偏好的运镜（面板用来给用户提示，不强制） */
  cameraHints?: string[]
  /** 每镜头的后处理通道名（会被 shot.postFX 追加） */
  postFX?: string[]
  /** 六大视觉维度（style.ts）；旧预设可以不填 */
  style?: import('./style').StyleSpec
  build: (ctx: PresetBuildContext) => ReactNode
  background?: (ctx: PresetBackgroundContext) => string | undefined
  postFXConfig?: (ctx: PresetPostFXContext) => Partial<PostFXConfig>
}
