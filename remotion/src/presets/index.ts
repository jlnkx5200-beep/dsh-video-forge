/**
 * 预设注册表：plan.preset 写哪个 id，就用哪套视觉语言。
 *
 * 六个 `StyleSpec` 预设是「商业级」默认（docs/visual-quality-standard.md），它们的 `style` 字段就是六大视觉维度的
 * 唯一真源；旧的 spatial / parallax / video-first 作为 legacy 保留，仍可被 plan 选中，
 * 但新的分镜编排默认走 STYLE_PRESETS。
 */
import type { StagePreset } from './types'
import { STYLE_PRESETS, styleSpecOf } from './library'
import { spatialPreset } from './spatial'
import { parallaxPreset } from './parallax'
import { videoFirstPreset } from './videoFirst'

export const PRESETS: Record<string, StagePreset> = {
  // —— 六套风格预设（推荐） ——
  'cinematic-realism': STYLE_PRESETS[0]!,
  'editorial-minimal': STYLE_PRESETS[1]!,
  'anime-atmospheric': STYLE_PRESETS[2]!,
  'cyber-neon': STYLE_PRESETS[3]!,
  'oriental-ink': STYLE_PRESETS[4]!,
  // 视频融合预设沿用旧实现（它已经专门为视频层调过），新 id 与旧 id 指向同一个预设
  'video-first': videoFirstPreset,
  // —— legacy ——
  spatial: spatialPreset,
  parallax: parallaxPreset,
}

/** 默认预设：没有特别指定时走电影写实。 */
export const DEFAULT_PRESET_ID = 'cinematic-realism'

export function registerPreset(preset: StagePreset): void {
  PRESETS[preset.id] = preset
}

export function listPresets(): Array<{ id: string; name: string; description: string; cameraHints: string[] }> {
  return Object.values(PRESETS).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    cameraHints: p.cameraHints ?? [],
  }))
}

export { STYLE_PRESETS, styleSpecOf }
export type { StagePreset, PresetBuildContext } from './types'
export type { StyleSpec } from './style'
