/**
 * 镜头内共享的相机采样：合成器每帧算完运镜后写进这个 ref，
 * 场景内的材质（视差层等）在下一帧读到它，把相机位移转成 UV/顶点偏移。
 * 一帧延迟对视觉无影响（1/30s 的视差量极小），换来的是"场景组件不必知道相机从哪来"。
 */
import { createContext, useContext } from 'react'
import * as THREE from 'three'

export interface CameraTelemetry {
  position: THREE.Vector3
  lookAt: THREE.Vector3
  /** 镜头归一化时间 0..1 */
  progress: number
}

export const CameraTelemetryContext = createContext<{ current: CameraTelemetry }>({
  current: { position: new THREE.Vector3(), lookAt: new THREE.Vector3(0, 0, -1), progress: 0 },
})

export function useCameraTelemetry(): { current: CameraTelemetry } {
  return useContext(CameraTelemetryContext)
}

/** 作用域：让场景组件知道"自己是第几号镜头、在镜头内的哪一帧"。 */
export interface ShotScope {
  shotId: string
  localFrame: number
  durationInFrames: number
  progress: number
  fps: number
  seed: number
}

export const ShotScopeContext = createContext<ShotScope>({
  shotId: 'unknown',
  localFrame: 0,
  durationInFrames: 1,
  progress: 0,
  fps: 30,
  seed: 0,
})

export function useShotScope(): ShotScope {
  return useContext(ShotScopeContext)
}
