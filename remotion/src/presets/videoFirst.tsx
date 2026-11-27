/**
 * Reference Preset C —— 「Video First」
 *
 * 给 `strategy: minimax-direct` 的镜头用：不做静帧 3D 化，直接让 H3 视频成为画面主体，
 * 只在四周保留极少量的空间元素（雾、微粒），保证"直出也像成片而不是贴图"。
 *
 * 存在意义：人工覆写（某镜头纯 H3 直出）在渲染侧必须有一等公民待遇，
 * 而不是被硬塞进 2.5D 流程里。
 */
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { InstancedSpatialField } from '../engine/InstancedSpatialField'
import { DepthParallaxLayer } from '../engine/DepthParallaxLayer'
import { MultiBlendVideoPlane } from '../engine/MultiBlendVideoPlane'
import { useShotScope } from '../engine/CameraContext'
import type { StagePreset } from './types'

export const videoFirstPreset: StagePreset = {
  id: 'video-first',
  name: '视频直出 Video First',
  description: 'H3 视频作为主体，空间只留微粒与雾，适合实拍感镜头、人物特写、需要真实运动的段落。',
  cameraHints: ['static', 'handheld', 'dolly-in'],
  postFX: ['clean', 'grade'],
  build: ({ plan, shot }) => Content(plan, shot),
  background: ({ plan }) => plan.style?.background ?? '#03040a',
  postFXConfig: () => ({ grain: 0.008, vignette: 0.18, saturation: 1.02, bloom: 0.16, bloomThreshold: 0.8 }),
}

function Content(
  plan: Parameters<NonNullable<StagePreset['build']>>[0]['plan'],
  shot: Parameters<NonNullable<StagePreset['build']>>[0]['shot'],
): ReactNode {
  const scope = useShotScope()
  const fogColor = plan.style?.fogColor ?? '#04060c'
  const accent = plan.style?.palette?.[1] ?? '#9db6cc'

  return (
    <group>
      {/* 视频主体：轻微弧幕 + 可选抠像 */}
      {shot.video !== undefined ? (
        <MultiBlendVideoPlane
          src={shot.video.src}
          blend={shot.video.blend}
          opacity={shot.video.opacity}
          chromaKey={shot.video.chromaKey}
          width={shot.video.width ?? 20}
          height={shot.video.height ?? 11.25}
          curvature={shot.video.blend === 'lumaKey' ? 0 : 0.08}
          position={[0, 0, -6]}
          lumaBoost={0.3}
        />
      ) : null}

      {/* 若没有视频（降级/SKIP），退到静帧 2.5D 面板兜底，绝不留黑屏。
          注意不能把静帧塞进 MultiBlendVideoPlane —— 那会把 jpg 当视频 seek，永远等不到 seeked。 */}
      {shot.video === undefined && shot.assets.still !== undefined ? (
        <DepthParallaxLayer
          src={shot.assets.still}
          parallax={0.12}
          width={20}
          height={11.25}
          position={[0, 0, -6]}
          layers={1}
          tint={accent}
          tintAmount={0.06}
          seed={scope.seed + 11}
        />
      ) : null}

      {/* 前后景微粒：给"无 3D 主体"的画面一点空气与景深线索。
          2026-11-27 水墨片实测：count 220 / size 0.07 在浅底留白画面上会结成肉眼可见的
          灰球，抢主体的墨韵；降到 110 / 0.035 后仍有颗粒感，但不再"飘雪花"。 */}
      <InstancedSpatialField
        count={110}
        shape="sphere"
        spread={[16, 9, 10]}
        center={[0, 0.4, -2.5]}
        size={0.035}
        sizeVariance={1.1}
        amplitude={0.16}
        fogColor={fogColor}
        fogNear={1}
        fogFar={14}
        fogPower={2.0}
        baseColor={accent}
        accentColor={fogColor}
        rim={1.2}
        seed={scope.seed + 41}
        spin={0.2}
      />

      {/* 顶部柔光条，避免纯视频画面显得"贴片" */}
      <mesh position={[0, 5.2, -5]} frustumCulled={false}>
        <planeGeometry args={[26, 6]} />
        <meshBasicMaterial color={accent} transparent opacity={0.05} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  )
}
