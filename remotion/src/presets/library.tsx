/**
 * 六套商业级风格预设（Reference Presets）。
 *
 * 设计约束（与 docs/visual-quality-standard.md 一致）：
 *  1. 预设只是数据的组合 —— 所有几何/材质都来自 engine 的四个风格无关原语；
 *  2. 每个预设必须显式声明六大维度（见 style.ts），不允许"审美默认值留空"；
 *  3. 图层尺寸一律由 `frameAt()` 按「相机距离 + fov + 画幅」推导 ——
 *     硬编码尺寸会把 2K 原图放大两三倍，那正是以前"糊"的根因；
 *  4. 视频层永远不整屏：占画面高度 `optics.videoCoverage`（默认 ≤0.75）并带羽化，
 *     保证 2K 静帧视差层始终是画面主体。
 */
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { DepthParallaxLayer } from '../engine/DepthParallaxLayer'
import { InstancedSpatialField } from '../engine/InstancedSpatialField'
import { MultiBlendVideoPlane } from '../engine/MultiBlendVideoPlane'
import { useShotScope } from '../engine/CameraContext'
import { frameAt, lightingToPostFX, resolveStyle, type StyleSpec } from './style'
import type { PresetBuildContext, StagePreset } from './types'
import type { ShotPlan } from '../plan/types'

const ASPECT = 16 / 9

/** 大气透视：一条贴着地平线的柔和光带（加性混合，不遮暗部） */
function Atmosphere({ spec, distance, height }: { spec: StyleSpec; distance: number; height: number }): React.JSX.Element | null {
  if (spec.spatial.atmosphereOpacity <= 0.001) return null
  const frame = frameAt(distance, spec.optics.fov, ASPECT)
  const bandHeight = frame.height * 0.55
  const y = (0.5 - spec.spatial.horizon) * height
  return (
    <mesh position={[0, y, -distance + 0.6]} renderOrder={-1} frustumCulled={false}>
      <planeGeometry args={[frame.width * 1.35, bandHeight, 1, 1]} />
      <meshBasicMaterial
        color={spec.spatial.atmosphere}
        transparent
        opacity={Math.min(0.6, spec.spatial.atmosphereOpacity)}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        depthTest={false}
      />
    </mesh>
  )
}


/** 微粒：尘埃 / 光斑 / 雪 / 全息点 */
function Particles({ spec, seed }: { spec: StyleSpec; seed: number }): React.JSX.Element | null {
  const s = spec.surface
  if (s.particle === 'none' || s.count <= 0) return null
  const shape = s.particle === 'snow' ? 'plane' : 'sphere'
  const size = s.particle === 'bokeh' ? s.size * 2.4 : s.particle === 'snow' ? s.size * 1.2 : s.size
  return (
    <InstancedSpatialField
      count={s.count}
      shape={shape}
      spread={s.spread}
      center={[0, 0.6, -5]}
      size={size}
      sizeVariance={0.45}
      amplitude={s.amplitude}
      baseColor={s.color}
      accentColor={s.color}
      rim={s.particle === 'holo' ? 1.4 : 0.9}
      fogColor={spec.spatial.atmosphere}
      fogNear={6}
      fogFar={34}
      fogPower={1.4}
      spin={0.4}
      seed={seed}
    />
  )
}

/**
 * 标准图层栈：背景板 → 主体层（带 matte / depth 位移）→ 视频层 → 大气 → 微粒。
 *
 * 有 plate（背景板）时，带主体的静帧**只**出现在主体层，远景用修复过的背景板 ——
 * 这正是消除 2.5D 边缘撕裂的做法（主体移动时不会把背后的"自己"一起拽动）。
 */
function StageStack({
  ctx,
  spec,
  depthOverride,
  parallaxScale = 1,
  videoBlend,
  showParticles = true,
}: {
  ctx: PresetBuildContext
  spec: StyleSpec
  depthOverride?: number
  parallaxScale?: number
  videoBlend?: 'normal' | 'additive' | 'multiply' | 'lumaKey'
  showParticles?: boolean
}): ReactNode {
  const scope = useShotScope()
  const shot = ctx.shot
  const still = shot.assets.still
  const plate = shot.assets.plate
  const depth = shot.layer?.depthSrc ?? shot.assets.depth
  const matte = shot.layer?.matteSrc ?? shot.assets.matte
  const video = shot.video
  const parallaxBase = shot.layer?.parallax ?? spec.spatial.parallax
  const fov = shot.camera?.fov ?? spec.optics.fov
  const displacement = depthOverride ?? spec.spatial.displacement

  // 取整段运镜里"最远"的那个机位距离来定图层尺寸：远机位看到的可视范围最大，
  // 只要那个距离能被盖住，推近时就更不可能露边（反过来会把画面放大到糊）。
  const camZs = [shot.camera?.from?.position?.[2], shot.camera?.to?.position?.[2]].filter(
    (v): v is number => typeof v === 'number',
  )
  const farthest = (planeZ: number) => {
    const distances = camZs.map(camZ => Math.abs(planeZ - camZ))
    return distances.length ? Math.max(...distances) : Math.abs(planeZ)
  }
  const plateFrame = frameAt(farthest(-spec.spatial.plateDepth), fov, ASPECT)
  const subjectFrame = frameAt(farthest(-spec.spatial.subjectDepth), fov, ASPECT)
  // 没有 plate 时不能把 matte 当 alpha 用：风景/大场景里 BiRefNet 常给出整幅前景，
  // 硬抠会把整层变成半透明面片（历史上就是这个导致画面糊）。只有存在背景板时才做前/背景拆分。
  const useSplit = plate !== undefined && plate !== ''

  return (
    <group>
      {/* 远景只画一次：只有存在「背景板」时才额外铺一层，否则同一张图铺两层会互相错位成"重影"（曾误判为发糊） */}
      {useSplit && (plate ?? '') !== '' ? (
        <DepthParallaxLayer
          src={(useSplit ? plate : still) as string}
          parallax={parallaxBase * 0.35 * parallaxScale}
          width={plateFrame.width * 1.25}
          height={plateFrame.height * 1.25}
          position={[0, 0, -spec.spatial.plateDepth]}
          depth={displacement * 0.45}
          tint={spec.spatial.atmosphere}
          tintAmount={Math.min(0.35, spec.spatial.atmosphereOpacity * 0.8)}
          opacity={1}
          seed={scope.seed}
        />
      ) : null}

      {/* 主体层：带 matte 时只画主体（alpha 抠像），带 depth 时按深度做顶点位移 */}
      {still !== undefined && still !== '' ? (
        <DepthParallaxLayer
          src={still}
          depthSrc={depth}
          matteSrc={useSplit ? matte : undefined}
          parallax={parallaxBase * parallaxScale}
          width={subjectFrame.width * 1.02}
          height={subjectFrame.height * 1.02}
          position={[0, 0, -spec.spatial.subjectDepth]}
          depth={displacement}
          tint={spec.surface.tint}
          tintAmount={spec.surface.tintAmount}
          edgeBoost={spec.surface.edgeBoost}
          opacity={useSplit ? 0.98 : 1}
          seed={scope.seed}
        />
      ) : null}

      {/* 视频层：满幅贴到主体平面（比画面略大，运镜时不露边）。
          这里刻意不做"画中画"——硬边矩形是廉价感的最大来源；
          想融合就靠 luma key / 掩码在亮度层叠合，而不是加个边框贴纸。 */}
      {video !== undefined && video.src !== '' ? (
        <MultiBlendVideoPlane
          src={video.src}
          blend={videoBlend ?? video.blend}
          opacity={video.opacity ?? 1}
          chromaKey={video.chromaKey}
          width={subjectFrame.width * 1.04}
          height={subjectFrame.height * 1.04}
          curvature={0.02}
          feather={0}
          position={[0, 0, -spec.spatial.subjectDepth + 0.4]}
          lumaBoost={0.12}
          offsetSeconds={0}
        />
      ) : null}

      {showParticles ? <Particles spec={spec} seed={scope.seed} /> : null}
    </group>
  )
}

/** 由一个 StyleSpec 造出 StagePreset：build 走标准图层栈，postFX 由 lighting 推导。 */
function makePreset(
  specInput: Partial<StyleSpec> & { id: string; name: string },
  options: { postFX?: string[]; videoBlend?: 'normal' | 'additive' | 'multiply' | 'lumaKey'; extraPostFX?: Record<string, unknown> } = {},
): StagePreset {
  const spec = resolveStyle(specInput)
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    cameraHints: spec.cameraHints,
    postFX: options.postFX ?? ['grade'],
    build: ctx => <StageStack ctx={ctx} spec={spec} videoBlend={options.videoBlend} />,
    background: ({ plan }) => plan.style?.background ?? spec.spatial.atmosphere,
    postFXConfig: () => lightingToPostFX(spec.lighting, { dof: spec.optics.dof, focus: spec.optics.focus }),
    style: spec,
  } as StagePreset & { style: StyleSpec }
}

/* ------------------------------------------------------------------ */
/* 1. 电影写实                                                         */
/* ------------------------------------------------------------------ */
export const cinematicRealism = makePreset({
  id: 'cinematic-realism',
  name: '电影写实 Cinematic Realism',
  description: 'ACES 胶片色调、柔和泛光、可控景深、沉稳推轨与细腻空气尘埃；适合实拍质感的产品与风景。',
  cameraHints: ['dolly-in', 'crane-up', 'pan', 'static'],
  lighting: {
    exposure: 0.88, contrast: 1.07, saturation: 1.02,
    lift: [0.006, 0.004, 0.012], gain: [1.03, 1.0, 0.985],
    bloom: 0.07, bloomThreshold: 0.93, bloomRadius: 0.9, vignette: 0.17,
  },
  optics: { fov: 40, dof: 0.1, focus: [0.5, 0.54], videoCoverage: 0.58, feather: 0.26 },
  spatial: {
    parallax: 0.55, displacement: 0.8, plateDepth: 12.5, subjectDepth: 6.8,
    atmosphere: '#0c1424', atmosphereOpacity: 0.16, horizon: 0.56,
  },
  surface: {
    particle: 'dust', count: 320, color: '#dbe6f5', size: 0.03,
    spread: [30, 14, 22], amplitude: 0.34, edgeBoost: 0.03,
    tint: '#ffffff', tintAmount: 0.03,
  },
  motion: { arc: 1.15, drift: 0.12, transition: 'crossfade' },
  promptModifiers: {
    anchors: [
      '电影级写实摄影', '柔和自然光与体积光', '前景中景背景三层景深', '35mm 胶片质感',
      '低饱和高级灰调', '细腻空气感与薄雾', '清晰的主体轮廓与材质细节',
    ],
    negative: ['涂抹感', '过度锐化', '高噪点', '水印', '文字', 'logo', '低质纹理', '扁平构图', '畸变肢体'],
  },
}, { postFX: ['grade'] })

/* ------------------------------------------------------------------ */
/* 2. 极简杂志 / 空间构成                                              */
/* ------------------------------------------------------------------ */
export const editorialMinimal = makePreset({
  id: 'editorial-minimal',
  name: '极简杂志 Editorial Minimal',
  description: '干净通透的高级灰与暖白光影、克制视差、几乎无颗粒；适合包装、排版、产品静物与留白叙事。',
  cameraHints: ['pan', 'dolly-out', 'static'],
  lighting: {
    exposure: 0.94, contrast: 1.05, saturation: 0.97,
    lift: [0.012, 0.011, 0.010], gain: [1.01, 1.005, 1.0],
    bloom: 0.04, bloomThreshold: 0.95, bloomRadius: 0.8, vignette: 0.06,
  },
  optics: { fov: 45, dof: 0.1, focus: [0.5, 0.5], videoCoverage: 0.55, feather: 0.2 },
  spatial: {
    parallax: 0.32, displacement: 0.42, plateDepth: 14, subjectDepth: 8,
    atmosphere: '#f4f1ec', atmosphereOpacity: 0.05, horizon: 0.5,
  },
  surface: {
    particle: 'none', count: 0, color: '#ffffff', size: 0.02,
    spread: [10, 6, 10], amplitude: 0, edgeBoost: 0,
    tint: '#ffffff', tintAmount: 0.05,
  },
  motion: { arc: 0.7, drift: 0.04, transition: 'luma-wipe' },
  promptModifiers: {
    anchors: ['极简主义构图', '大面积留白', '高级灰调', '暖白柔光', '克制的材质细节', '干净背景'],
    negative: ['杂乱背景', '密集纹理', '高饱和', '噪点', '水印', '文字', '过度装饰'],
  },
}, { postFX: ['clean'] })

/* ------------------------------------------------------------------ */
/* 3. 日系通透 / 新海诚氛围                                            */
/* ------------------------------------------------------------------ */
export const animeAtmospheric = makePreset({
  id: 'anime-atmospheric',
  name: '日系通透 Anime Atmospheric',
  description: '清澈高光天光、柔和漫反射辉光、明显前后景层次与轻盈飘浮光斑；适合插画、二次元与清新叙事。',
  cameraHints: ['pan', 'dolly-in', 'crane-up'],
  lighting: {
    exposure: 0.96, contrast: 1.03, saturation: 1.12,
    lift: [0.008, 0.012, 0.02], gain: [1.02, 1.0, 1.02],
    bloom: 0.12, bloomThreshold: 0.9, bloomRadius: 1.0, vignette: 0.07,
  },
  optics: { fov: 38, dof: 0.1, focus: [0.5, 0.46], videoCoverage: 0.6, feather: 0.28 },
  spatial: {
    parallax: 0.62, displacement: 0.7, plateDepth: 13, subjectDepth: 6.5,
    atmosphere: '#cfe4ff', atmosphereOpacity: 0.2, horizon: 0.62,
  },
  surface: {
    particle: 'bokeh', count: 420, color: '#ffeccd', size: 0.05,
    spread: [28, 16, 20], amplitude: 0.5, edgeBoost: 0.02,
    tint: '#eaf3ff', tintAmount: 0.06,
  },
  motion: { arc: 1.1, drift: 0.18, transition: 'noise-dissolve' },
  promptModifiers: {
    anchors: ['新海诚风格', '清澈通透的夏日天空', '柔和漫反射光晕', '云隙光', '明显的前后景层次', '轻盈飘浮的光斑'],
    negative: ['脏灰', '涂抹感', '噪点', '水印', '文字', '厚涂', '低分辨率'],
  },
}, { postFX: ['grade', 'glow'] })

/* ------------------------------------------------------------------ */
/* 4. 赛博霓虹                                                        */
/* ------------------------------------------------------------------ */
export const cyberNeon = makePreset({
  id: 'cyber-neon',
  name: '赛博霓虹 Cyber Neon',
  description: '冷暖双色边缘光、可控非溢出 Bloom、空间网格与几何阵列；适合科技产品、发布会与未来感叙事。',
  cameraHints: ['orbit', 'dolly-in', 'handheld'],
  lighting: {
    exposure: 0.82, contrast: 1.14, saturation: 1.08,
    lift: [0.012, 0.0, 0.028], gain: [0.97, 1.0, 1.1],
    bloom: 0.16, bloomThreshold: 0.88, bloomRadius: 1.1, vignette: 0.28,
  },
  optics: { fov: 36, dof: 0.16, focus: [0.5, 0.52], videoCoverage: 0.62, feather: 0.24 },
  spatial: {
    parallax: 0.66, displacement: 0.65, plateDepth: 11, subjectDepth: 6,
    atmosphere: '#050810', atmosphereOpacity: 0.28, horizon: 0.5,
  },
  surface: {
    particle: 'holo', count: 520, color: '#6ef0ff', size: 0.032,
    spread: [24, 12, 26], amplitude: 0.42, edgeBoost: 0.06,
    tint: '#a8dcff', tintAmount: 0.05,
  },
  motion: { arc: 1.25, drift: 0.1, transition: 'radial-blur' },
  promptModifiers: {
    anchors: ['赛博朋克', '冷暖双色边缘光', '霓虹反射与湿地面', '体积雾', '高科技几何阵列', '硬朗材质与金属细节'],
    negative: ['过曝溢出', '脏灰', '噪点', '水印', '文字', '杂乱主体', '低质纹理'],
  },
}, { postFX: ['grade', 'bloom'] })

/* ------------------------------------------------------------------ */
/* 5. 东方水墨 / 意境留白                                              */
/* ------------------------------------------------------------------ */
export const orientalInk = makePreset({
  id: 'oriental-ink',
  name: '东方意境 Oriental Ink',
  description: '远近层次空气透视雾、低饱和雅致色阶、缓慢横移长镜头；适合水墨、山水、文化叙事与东方留白。',
  cameraHints: ['pan', 'static', 'dolly-out'],
  lighting: {
    // 2026-11-27 水墨开篇实测（R6 的老账）：exposure 压到 0.92、contrast 提到 1.03，
    // 推镜推进雾幕的末段不再把焦墨主体洗成一片白；saturation 0.84 保留宣纸的冷米白。
    exposure: 0.92, contrast: 1.03, saturation: 0.84,
    lift: [0.01, 0.011, 0.012], gain: [1.0, 1.0, 1.0],
    bloom: 0.05, bloomThreshold: 0.94, bloomRadius: 0.9, vignette: 0.12,
  },
  optics: { fov: 42, dof: 0.12, focus: [0.5, 0.5], videoCoverage: 0.55, feather: 0.3 },
  spatial: {
    // R6 结论「雾占比过高会吃掉山峦对比度」：0.3 → 0.18，留白仍在，但墨色主体不再发灰。
    parallax: 0.4, displacement: 0.6, plateDepth: 15, subjectDepth: 8.5,
    atmosphere: '#e6ecef', atmosphereOpacity: 0.18, horizon: 0.6,
  },
  surface: {
    particle: 'dust', count: 160, color: '#ffffff', size: 0.022,
    spread: [22, 10, 18], amplitude: 0.22, edgeBoost: 0,
    tint: '#f0f4f6', tintAmount: 0.1,
  },
  motion: { arc: 0.55, drift: 0.05, transition: 'luma-wipe' },
  promptModifiers: {
    anchors: ['东方水墨意境', '大量留白', '远近层次空气透视', '墨色浓淡与皴擦笔触', '低饱和雅致色阶', '云雾缭绕'],
    negative: ['高饱和', '西方油画', '噪点', '水印', '文字', '塑料质感', '过度锐化'],
  },
}, { postFX: ['grade'] })

/* ------------------------------------------------------------------ */
/* 6. 视频精修融合                                                     */
/* ------------------------------------------------------------------ */
export const videoFirst = makePreset({
  id: 'video-first',
  name: '视频融合 Video First',
  description: '针对高质量 AI 视频做边缘羽化、调色匹配、景深弧幕与微粒融景，避免"视频贴纸"感；也兼容纯静帧兜底。',
  cameraHints: ['static', 'dolly-in', 'pan'],
  lighting: {
    exposure: 0.9, contrast: 1.06, saturation: 1.03,
    lift: [0.005, 0.005, 0.008], gain: [1.01, 1.0, 1.0],
    bloom: 0.16, bloomThreshold: 0.88, bloomRadius: 1.3, vignette: 0.13,
  },
  optics: { fov: 44, dof: 0.2, focus: [0.5, 0.5], videoCoverage: 0.74, feather: 0.3 },
  spatial: {
    parallax: 0.45, displacement: 0.55, plateDepth: 13, subjectDepth: 7,
    atmosphere: '#0a0e16', atmosphereOpacity: 0.12, horizon: 0.55,
  },
  surface: {
    particle: 'bokeh', count: 260, color: '#e8eefc', size: 0.036,
    spread: [26, 12, 24], amplitude: 0.3, edgeBoost: 0.02,
    tint: '#ffffff', tintAmount: 0.02,
  },
  motion: { arc: 0.8, drift: 0.08, transition: 'crossfade' },
  promptModifiers: {
    anchors: ['实拍级质感', '稳定的镜头运动', '自然的景深过渡', '柔和边缘与光影融合', '真实材质反射'],
    negative: ['抖动', '闪烁', '贴纸感硬边', '噪点', '水印', '文字', '低分辨率'],
  },
}, { postFX: ['grade'] })

/** 六套开箱即用预设（顺序即面板展示顺序） */
export const STYLE_PRESETS: StagePreset[] = [
  cinematicRealism,
  editorialMinimal,
  animeAtmospheric,
  cyberNeon,
  orientalInk,
  videoFirst,
]

/** 预设 id → 它的 StyleSpec（host 侧 prompt compiler 用的锚点词也在这里取一份镜像）。 */
export function styleSpecOf(id: string): StyleSpec | undefined {
  return (STYLE_PRESETS.find(p => p.id === id) as (StagePreset & { style?: StyleSpec }) | undefined)?.style
}

/** 兼容旧代码：把 ShotPlan 的资产映射成图层参数的辅助（外部一般不用）。 */
export function shotHasVideo(shot: ShotPlan): boolean {
  return shot.video !== undefined && shot.video.src !== ''
}
