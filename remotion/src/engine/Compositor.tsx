/**
 * 合成器：一帧内决定"渲染哪个镜头、要不要转场、跑哪套后处理"。
 *
 * 渲染流程（每帧）：
 *   1. 找当前镜头，按运镜曲线更新它的相机
 *   2. 若处于转场窗口：把当前镜头与下一镜头各渲到一张 RT，再用转场 shader 混合
 *   3. 把结果过一遍后处理链（PostChain），最终写屏
 *
 * 为什么手动接管渲染：R3F 默认只渲染一个 scene + 一个 camera，
 * 而转场需要"两个场景、两台相机、一张 RT"，只能在 priority>0 的 useFrame 里自己做。
 */
import { useMemo, useRef } from 'react'
import { createPortal, useFrame, useThree } from '@react-three/fiber'
import { SceneReadyKicker } from './SceneKicker'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import * as THREE from 'three'
import { CameraPath, applyCameraSample, type CameraSample } from './camera'
import { CameraTelemetryContext, ShotScopeContext, type CameraTelemetry, type ShotScope } from './CameraContext'
import { PostChain, TransitionMixer, makeRenderTarget, renderSceneToScreen, renderSceneToTarget, type PostFXConfig } from './postfx'
import { resolvePostFX, selectMaterialStyle } from './ComposablePostFX'
import { needsDualPass, transitionDirection, transitionMode, transitionProgress } from './transitions'
import { isVideoStrategy } from '../plan/types'
import type { RenderPlan, ShotPlan } from '../plan/types'
import { PRESETS } from '../presets'
import type { StagePreset } from '../presets/types'

interface ShotRuntime {
  shot: ShotPlan
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  path: CameraPath
  telemetry: { current: CameraTelemetry }
  style: ReturnType<typeof selectMaterialStyle>
}

function shotIndexAt(shots: ShotPlan[], frame: number): number {
  for (let i = shots.length - 1; i >= 0; i -= 1) {
    const shot = shots[i]!
    if (frame >= shot.from) return i
  }
  return 0
}

function backgroundFor(plan: RenderPlan, preset: StagePreset | undefined, shot: ShotPlan): string {
  const fromPreset = preset?.background?.({ plan, shot })
  if (fromPreset !== undefined) return fromPreset
  if (plan.style?.background !== undefined && plan.style.background !== '') return plan.style.background
  if (plan.style?.fogColor !== undefined && plan.style.fogColor !== '') return plan.style.fogColor
  return '#070a12'
}

export interface CompositorProps {
  plan: RenderPlan
  width: number
  height: number
  /** 绕过 PostChain 直接渲屏，排查后处理问题时用 */
  disablePostFX?: boolean
}

export function Compositor({ plan, width, height, disablePostFX = false }: CompositorProps): React.JSX.Element {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const gl = useThree(state => state.gl)

  const presetId = plan.preset
  const preset = PRESETS[presetId] ?? PRESETS['cinematic-realism'] ?? Object.values(PRESETS)[0]!
  const fallbackPreset = Object.values(PRESETS)[0]!

  const runtimes = useMemo<ShotRuntime[]>(() => {
    const style = selectMaterialStyle(plan.style?.tags)
    return plan.shots.map(shot => {
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(backgroundFor(plan, preset, shot))
      const camera = new THREE.PerspectiveCamera(shot.camera.fov, width / Math.max(1, height), 0.05, 400)
      return {
        shot,
        scene,
        camera,
        path: new CameraPath(shot.camera),
        telemetry: { current: { position: new THREE.Vector3(), lookAt: new THREE.Vector3(0, 0, -1), progress: 0 } },
        style,
      }
    })
    // 只在 plan 结构变化时重建场景
  }, [plan, width, height, preset])

  const postChain = useMemo(() => new PostChain(gl, width, height), [gl, width, height])
  const mixer = useMemo(() => new TransitionMixer(), [])
  const targets = useMemo(() => ({
    a: makeRenderTarget(width, height),
    b: makeRenderTarget(width, height),
    mix: makeRenderTarget(width, height),
  }), [width, height])

  const sizeRef = useRef({ width, height })

  useFrame(() => {
    const shots = runtimes
    if (shots.length === 0) return

    const currentIndex = shotIndexAt(plan.shots, frame)
    const current = shots[currentIndex]
    if (current === undefined) return
    const next = shots[currentIndex + 1]

    // 尺寸变化时重建后处理链的 RT
    if (sizeRef.current.width !== width || sizeRef.current.height !== height) {
      sizeRef.current = { width, height }
      postChain.setSize(width, height)
    }

    // 1. 更新当前镜头相机（镜头内时间归一）
    const localT = current.shot.durationInFrames <= 1 ? 0 : (frame - current.shot.from) / (current.shot.durationInFrames - 1)
    const sample = current.path.sample(Math.min(1, Math.max(0, localT)))
    applyCameraSample(current.camera, sample, current.shot.camera.fov)
    current.telemetry.current.position.copy(sample.position)
    current.telemetry.current.lookAt.copy(sample.lookAt)
    current.telemetry.current.progress = localT

    // 2. 判断是否处于转场窗口
    const outTransition = current.shot.transitionOut
    const inTransition = next?.shot.transitionIn
    const duration = outTransition?.durationInFrames ?? inTransition?.durationInFrames ?? 0
    const transitionStart = current.shot.from + current.shot.durationInFrames - duration
    const transitioning = next !== undefined && duration > 0 && frame >= transitionStart && needsDualPass(outTransition?.type ?? inTransition?.type)

    const background = current.scene.background instanceof THREE.Color ? current.scene.background : new THREE.Color('#070a12')

    if (transitioning && next !== undefined) {
      const progress = transitionProgress(frame, transitionStart, duration)
      // 下一镜头在转场期间保持第一帧（时间轴不重叠，避免开始后跳），相机停在 t=0
      const nextSample = next.path.sample(0)
      applyCameraSample(next.camera, nextSample, next.shot.camera.fov)
      next.telemetry.current.position.copy(nextSample.position)
      next.telemetry.current.lookAt.copy(nextSample.lookAt)
      next.telemetry.current.progress = 0

      renderSceneToTarget(gl, current.scene, current.camera, targets.a, background)
      renderSceneToTarget(gl, next.scene, next.camera, targets.b, new THREE.Color(backgroundFor(plan, preset, next.shot)))
      mixer.render(gl, targets.a.texture, targets.b.texture, {
        mode: transitionMode(outTransition?.type ?? inTransition?.type),
        progress,
        seed: currentIndex * 17 + 3,
        direction: transitionDirection(outTransition?.direction ?? inTransition?.direction),
        mask: null,
        radialAmount: 1.2 + progress * 1.6,
      }, targets.mix)
      postChain.render(gl, targets.mix.texture, postConfigFor(plan, current.shot, frame, fps, preset))
    } else {
      renderSceneToTarget(gl, current.scene, current.camera, targets.a, background)
      if (disablePostFX) renderSceneToScreen(gl, current.scene, current.camera, background)
      else postChain.render(gl, targets.a.texture, postConfigFor(plan, current.shot, frame, fps, preset))
    }
  }, 1)

  const scopeFor = (runtime: ShotRuntime): ShotScope => {
    const local = frame - runtime.shot.from
    return {
      shotId: runtime.shot.id,
      localFrame: Math.max(0, local),
      durationInFrames: runtime.shot.durationInFrames,
      progress: runtime.shot.durationInFrames <= 1 ? 0 : Math.max(0, local) / (runtime.shot.durationInFrames - 1),
      fps,
      seed: runtime.shot.index * 131 + 17,
    }
  }

  return (
    <>
      {/* 资源就绪后强制 R3F 重绘一帧（ThreeCanvas 渲染期 frameloop='never'） */}
      <SceneReadyKicker />
      {runtimes.map(runtime => {
        const activePreset = PRESETS[isVideoStrategy(runtime.shot.strategy) ? 'video-first' : plan.preset] ?? preset ?? fallbackPreset
        const content = (activePreset as StagePreset).build({
          plan,
          shot: runtime.shot,
          materialStyle: runtime.style,
          preset: activePreset as StagePreset,
        })
        return createPortal(
          <ShotScopeContext.Provider key={runtime.shot.id} value={scopeFor(runtime)}>
            <CameraTelemetryContext.Provider value={runtime.telemetry}>
              {content}
            </CameraTelemetryContext.Provider>
          </ShotScopeContext.Provider>,
          runtime.scene,
        )
      })}
    </>
  )
}

function postConfigFor(plan: RenderPlan, shot: ShotPlan, frame: number, fps: number, preset: StagePreset): PostFXConfig {
  const base = preset.postFXConfig?.({ plan, shot }) ?? {}
  const names = [...(preset.postFX ?? []), ...(shot.postFX ?? [])]
  const config = resolvePostFX(names, base)
  config.time = frame / fps
  config.seed = (shot.index + 1) * 31 + (frame % 997) * 0.0163
  return config
}
