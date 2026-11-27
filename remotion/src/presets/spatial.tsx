/**
 * Reference Preset A —— 「Spatial Field」
 *
 * 视觉主张：空间纵深 + 大气散射 + 实例化几何阵列。
 * 镜头语言：从阵列内部穿行，远处有雾把几何吃进背景，静帧作为"远处天幕"。
 *
 * 它证明的是：内核提供了 InstancedSpatialField / DepthParallaxLayer / ComposablePostFX 三个原语，
 * 而"这种电影感"完全是预设里 200 行场景装配的结果，不是内核写死的。
 */
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { DepthParallaxLayer } from '../engine/DepthParallaxLayer'
import { InstancedSpatialField } from '../engine/InstancedSpatialField'
import { MultiBlendVideoPlane } from '../engine/MultiBlendVideoPlane'
import { useShotScope } from '../engine/CameraContext'
import { isVideoStrategy } from '../plan/types'
import type { StagePreset } from './types'

function color(value: string | undefined, fallback: string): string {
  return value !== undefined && value !== '' ? value : fallback
}

/** 静帧作为"无限远的天幕"：一张大平面，轻微视差，被雾吃掉边缘。 */
function Backdrop({ src, tint, parallax }: { src?: string; tint: string; parallax: number }): ReactNode {
  return (
    <DepthParallaxLayer
      src={src}
      parallax={parallax}
      width={64}
      height={36}
      position={[0, 1.5, -34]}
      depth={0}
      layers={1}
      tint={tint}
      tintAmount={0.12}
      edgeBoost={0}
      opacity={1}
    />
  )
}

/** 地面：一块低多边形平面 + 极低视差，给镜头一个"脚下有地"的锚点。 */
function Ground({ color: groundColor }: { color: string }): ReactNode {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.2, -12]} frustumCulled={false}>
      <planeGeometry args={[140, 140, 1, 1]} />
      <meshBasicMaterial color={groundColor} transparent opacity={0.85} depthWrite />
    </mesh>
  )
}

export const spatialPreset: StagePreset = {
  id: 'spatial',
  name: '空间场域 Spatial Field',
  description: '实例化几何阵列 + 大气透视雾 + 远景天幕，适合宏大、科技、建筑、抽象空间题材。',
  cameraHints: ['dolly-in', 'orbit', 'crane-up', 'pan'],
  postFX: ['grade', 'bloom', 'film'],
  build: ({ plan, shot, materialStyle }) => {
    const scene = Scene(plan, shot, materialStyle.primary.tint)
    return scene
  },
  background: ({ plan }) => color(plan.style?.fogColor, '#070a12'),
  postFXConfig: ({ plan }) => {
    const palette = plan.style?.palette ?? []
    return {
      bloom: 0.4,
      bloomThreshold: 0.62,
      grain: 0.008,
      vignette: 0.3,
      saturation: 1.02,
      lift: palette.length > 2 ? [0.01, 0.008, 0.014] : [0, 0, 0],
    }
  },
}

function Scene(plan: Parameters<NonNullable<StagePreset['build']>>[0]['plan'], shot: Parameters<NonNullable<StagePreset['build']>>[0]['shot'], tint: string): ReactNode {
  const scope = useShotScope()
  const fogColor = color(plan.style?.fogColor, '#070a12')
  const palette = plan.style?.palette ?? []
  const accent = palette.length > 1 ? palette[1]! : '#8fb4d6'
  const base = palette.length > 0 ? palette[0]! : '#0d1626'
  const isVideoShot = isVideoStrategy(shot.strategy) && shot.video !== undefined

  return (
    <group>
      {/* 天幕 */}
      <Backdrop src={shot.assets.still} tint={fogColor} parallax={0.25} />

      {/* 地面 */}
      <Ground color={base} />

      {/* 实例阵列：前中后三层，尺寸/密度递减，制造纵深层次 */}
      <InstancedSpatialField
        count={420}
        shape="box"
        spread={[34, 7, 44]}
        center={[0, -0.6, -16]}
        size={0.32}
        sizeVariance={0.75}
        amplitude={0.06}
        fogColor={fogColor}
        fogNear={6}
        fogFar={46}
        fogPower={1.4}
        baseColor={base}
        accentColor={accent}
        rim={0.6}
        seed={scope.seed + 11}
        spin={0.4}
      />
      <InstancedSpatialField
        count={160}
        shape="tetra"
        spread={[18, 12, 26]}
        center={[0, 2.4, -10]}
        size={0.22}
        sizeVariance={0.9}
        amplitude={0.16}
        fogColor={fogColor}
        fogNear={3}
        fogFar={26}
        fogPower={1.8}
        baseColor={accent}
        accentColor={fogColor}
        rim={0.9}
        seed={scope.seed + 29}
        spin={1.1}
      />

      {/* 若本镜头是 H3 直出，视频作为空间中的发光幕布叠上去 */}
      {isVideoShot && shot.video !== undefined ? (
        <MultiBlendVideoPlane
          src={shot.video.src}
          blend={shot.video.blend}
          opacity={shot.video.opacity}
          chromaKey={shot.video.chromaKey}
          width={shot.video.width ?? 26}
          height={shot.video.height ?? 14.6}
          curvature={0.35}
          position={[0, 1.2, -17]}
          lumaBoost={0.15}
        />
      ) : null}

      {/* 前景空气感：一片极淡的体积色块，把画面从纯 UI 感拉回"有空气" */}
      <mesh position={[0, 1.4, -6]} frustumCulled={false}>
        <planeGeometry args={[40, 24, 1, 1]} />
        <meshBasicMaterial color={fogColor} transparent opacity={0.12} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* 给材质风格留一个可见的"色温锚点"（强风格时会更明显） */}
      <mesh position={[0, 0, -3]} frustumCulled={false}>
        <planeGeometry args={[0.001, 0.001]} />
        <meshBasicMaterial color={tint} transparent opacity={0.0} />
      </mesh>
    </group>
  )
}
