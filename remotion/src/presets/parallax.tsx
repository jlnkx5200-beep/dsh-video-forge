/**
 * Reference Preset B —— 「Layered Parallax」
 *
 * 视觉主张：多层 2.5D 纹理视差 + 视频混合叠加 + 风格化边缘/材质着色器。
 * 镜头语言：机位横移时，同一张图的近景/中景/远景以不同速度错开（纸片戏法），
 * 前景再叠一段 H3 视频（additive / luma key），做"实拍人物贴在插画世界里"的合成感。
 *
 * 它证明的是：同一套内核（DepthParallaxLayer / MultiBlendVideoPlane / ComposablePostFX），
 * 换一个预设就能从"宏大三维空间"切到"平面分层叙事"，而内核一行都不用改。
 */
import type { ReactNode } from 'react'
import { DepthParallaxLayer } from '../engine/DepthParallaxLayer'
import { MultiBlendVideoPlane } from '../engine/MultiBlendVideoPlane'
import { useShotScope } from '../engine/CameraContext'
import type { StagePreset } from './types'

export const parallaxPreset: StagePreset = {
  id: 'parallax',
  name: '分层视差 Layered Parallax',
  description: '2.5D 多层视差 + 混合模式视频叠加 + 风格化边缘材质，适合包装、叙事、插画、产品特写。',
  cameraHints: ['pan', 'dolly-in', 'handheld', 'static'],
  postFX: ['grade', 'glow'],
  build: ({ plan, shot, materialStyle }) => Content(plan, shot, materialStyle.primary.edgeBoost, materialStyle.primary.tint, materialStyle.primary.tintAmount),
  background: ({ plan }) => plan.style?.background ?? '#05060a',
  postFXConfig: ({ plan }) => ({
    grain: 0.008,
    vignette: 0.26,
    bloom: 0.3,
    saturation: 1.06,
    bloomThreshold: 0.6,
    lift: plan.style?.palette?.[2] !== undefined ? [0.012, 0.01, 0.016] : [0, 0, 0],
  }),
}

function Content(
  plan: Parameters<NonNullable<StagePreset['build']>>[0]['plan'],
  shot: Parameters<NonNullable<StagePreset['build']>>[0]['shot'],
  edgeBoost: number,
  tint: string,
  tintAmount: number,
): ReactNode {
  const scope = useShotScope()
  const still = shot.assets.still
  const depth = shot.layer?.depthSrc ?? shot.assets.depth
  const matte = shot.layer?.matteSrc ?? shot.assets.matte

  return (
    <group>
      {/* 远景：几乎不动，压低亮度把它推远 */}
      <DepthParallaxLayer
        src={still}
        parallax={0.18 + (shot.layer?.parallax ?? 0.5) * 0.2}
        width={54}
        height={30}
        position={[0, 0.6, -18]}
        layers={1}
        opacity={0.72}
        tint={tint}
        tintAmount={Math.max(0.1, tintAmount)}
        edgeBoost={edgeBoost * 0.3}
        seed={scope.seed}
      />

      {/* 中景：主体，带深度图位移与遮罩 */}
      <DepthParallaxLayer
        src={still}
        depthSrc={depth}
        matteSrc={matte}
        parallax={0.3 + (shot.layer?.parallax ?? 0.5) * 0.35}
        width={34}
        height={19.1}
        position={[0, 0.1, -8]}
        layers={1}
        layerGap={0.3}
        opacity={1}
        tint={tint}
        tintAmount={tintAmount}
        edgeBoost={edgeBoost}
        seed={scope.seed + 3}
      />

      {/* 视频叠加层：H3 产出贴在主体前方，按 plan 的 blend 合成 */}
      {shot.video !== undefined ? (
        <MultiBlendVideoPlane
          src={shot.video.src}
          blend={shot.video.blend}
          opacity={shot.video.opacity}
          chromaKey={shot.video.chromaKey}
          width={shot.video.width ?? 22}
          height={shot.video.height ?? 12.4}
          curvature={0.12}
          position={[0, 0.2, -4.4]}
          lumaBoost={0.28}
        />
      ) : null}

      {/* 前景装饰：一条高光斜带，横移时速度最快，强化层次（程序化，不依赖资产） */}
      <mesh position={[-2.2, 1.3, -1.6]} rotation={[0, 0, -0.35]} frustumCulled={false}>
        <planeGeometry args={[3.2, 22, 1, 1]} />
        <meshBasicMaterial color={plan.style?.palette?.[1] ?? '#ffffff'} transparent opacity={0.06} depthWrite={false} />
      </mesh>
    </group>
  )
}
