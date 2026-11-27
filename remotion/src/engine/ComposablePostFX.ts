/**
 * 图形原语 4：ComposablePostFX —— 可链式注入的后处理/材质注册表。
 *
 * 这是"风格无关"的关键：内核不认识任何风格，只认识**注册表里的名字**。
 *   - PASS_REGISTRY：后处理通道（bloom / grade / dof / grain / vignette / overlay …）
 *   - MATERIAL_STYLES：图层材质预设（边缘增强、冷暖偏移、低饱和…）
 * plan.postFX 里写名字，这里按顺序叠加；未注册的名字被忽略并告警。
 *
 * 想加新风格 = 往注册表里加一条，不需要改内核。
 */
import * as THREE from 'three'
import type { PostFXConfig } from './postfx'
import { DEFAULT_POSTFX } from './postfx'

export interface PassDefinition {
  id: string
  description: string
  /** 叠加到基础配置上的补丁；数值是"强度"，不是绝对值（除少量布尔式字段） */
  patch: Partial<PostFXConfig>
}

/** 后处理通道注册表 —— 名字即 plan.postFX 里的字符串。 */
export const PASS_REGISTRY: Record<string, PassDefinition> = {
  bloom: {
    id: 'bloom',
    description: '泛光：阈值提取 + 双向高斯，适合高光物体与体积光',
    patch: { bloom: 0.42, bloomThreshold: 0.7, bloomRadius: 1.6 },
  },
  glow: {
    id: 'glow',
    description: '轻量发光：比 bloom 更柔、阈值更低，适合风格化插画',
    patch: { bloom: 0.2, bloomThreshold: 0.7, bloomRadius: 2.0 },
  },
  grade: {
    id: 'grade',
    description: '色彩分级：对比度/饱和/色温（lift-gain）',
    // 克制的分级：以前 exposure 1.02 + saturation 1.08 会把高光雾面推白
    patch: { saturation: 1.03, contrast: 1.04, exposure: 0.92 },
  },
  film: {
    id: 'film',
    description: '胶片：颗粒 + 暗角 + 轻微降饱和',
    patch: { grain: 0.012, vignette: 0.16, saturation: 0.98, contrast: 1.04 },
  },
  clean: {
    id: 'clean',
    description: '干净交付：几乎无颗粒、轻微泛光',
    patch: { grain: 0.004, vignette: 0.08, bloom: 0.12, saturation: 1.0 },
  },
  dof: {
    id: 'dof',
    description: '景深：屏幕空间径向近似（焦点在中心或指定点）',
    patch: { dof: 0.85, focus: [0.5, 0.48] },
  },
  vignette: {
    id: 'vignette',
    description: '暗角',
    patch: { vignette: 0.34 },
  },
  warm: {
    id: 'warm',
    description: '暖调偏移（黄昏 / 室内）',
    patch: { lift: [0.02, 0.008, 0.0], gain: [1.06, 1.02, 0.96] },
  },
  cold: {
    id: 'cold',
    description: '冷调偏移（夜景 / 科技）',
    patch: { lift: [0.0, 0.004, 0.02], gain: [0.96, 1.01, 1.08] },
  },
}

/** 图层材质风格注册表 —— plan.style.tags 命中即可换观感。 */
export interface MaterialStyle {
  id: string
  description: string
  edgeBoost: number
  tintAmount: number
  tint: string
}

export const MATERIAL_STYLES: Record<string, MaterialStyle> = {
  natural: { id: 'natural', description: '自然：不干预颜色', edgeBoost: 0, tintAmount: 0, tint: '#ffffff' },
  edge: { id: 'edge', description: '风格化边缘：加强轮廓，像手绘/版画', edgeBoost: 0.75, tintAmount: 0.04, tint: '#e8f1ff' },
  ink: { id: 'ink', description: '墨感：提亮轮廓、压低彩度', edgeBoost: 0.5, tintAmount: 0.18, tint: '#f2f4f7' },
  duotoneWarm: { id: 'duotoneWarm', description: '暖双色', edgeBoost: 0.1, tintAmount: 0.22, tint: '#f0b27a' },
  duotoneCold: { id: 'duotoneCold', description: '冷双色', edgeBoost: 0.1, tintAmount: 0.22, tint: '#7fb6d9' },
}

export interface MaterialStyleSelection {
  primary: MaterialStyle
  /** 主风格 id，便于日志 */
  id: string
}

/** 按 plan.style.tags 选材质风格；一个都不匹配就用 natural。 */
export function selectMaterialStyle(tags: string[] | undefined): MaterialStyleSelection {
  for (const tag of tags ?? []) {
    const key = tag.trim()
    if (key === '') continue
    // 直接命中
    if (MATERIAL_STYLES[key] !== undefined) return { primary: MATERIAL_STYLES[key]!, id: key }
    // 关键词命中（"水墨 / ink" 之类都能接上）
    const lower = key.toLowerCase()
    const found = Object.values(MATERIAL_STYLES).find(style =>
      lower.includes(style.id.toLowerCase()) ||
      (style.id === 'ink' && (lower.includes('ink') || lower.includes('墨'))) ||
      (style.id === 'edge' && (lower.includes('edge') || lower.includes('outline') || lower.includes('轮廓'))),
    )
    if (found !== undefined) return { primary: found, id: found.id }
  }
  return { primary: MATERIAL_STYLES.natural!, id: 'natural' }
}

/** 把一串 pass 名字解析成最终后处理配置。未注册的名字被跳过。 */
export function resolvePostFX(names: string[] | undefined, base: Partial<PostFXConfig> = {}): PostFXConfig {
  const config: PostFXConfig = { ...DEFAULT_POSTFX, ...base }
  for (const name of names ?? []) {
    const def = PASS_REGISTRY[name]
    if (def === undefined) {
      console.warn('[video-forge] 未注册的后处理通道：' + name + '（已跳过，可用：' + Object.keys(PASS_REGISTRY).join(', ') + '）')
      continue
    }
    Object.assign(config, def.patch)
  }
  return config
}

/** 注册自定义 pass（运行时可扩展，面板/用户在 remotion 里也能加）。 */
export function registerPass(definition: PassDefinition): void {
  PASS_REGISTRY[definition.id] = definition
}

export function registerMaterialStyle(style: MaterialStyle): void {
  MATERIAL_STYLES[style.id] = style
}

/** 供 UI 展示 */
export function listPasses(): Array<{ id: string; description: string }> {
  return Object.values(PASS_REGISTRY).map(p => ({ id: p.id, description: p.description }))
}

export function listMaterialStyles(): Array<{ id: string; description: string }> {
  return Object.values(MATERIAL_STYLES).map(p => ({ id: p.id, description: p.description }))
}

/** 从 palette 里取第二色作为增益，做"整片统一色温"（可选能力）。 */
export function toneOverlayFromPalette(palette: string[] | undefined): THREE.Color | null {
  if (palette === undefined || palette.length < 2) return null
  try {
    return new THREE.Color(palette[1]!)
  } catch {
    return null
  }
}
