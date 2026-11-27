/**
 * 运镜求解：把 plan 里的两个关键帧 + 运镜名，解成一条**连续、可微、带阻尼**的相机轨道。
 *
 * 为什么不是直接 lerp：
 *   - 线性插值在起止处速度突变，肉眼是"顿一下"；这里用 CatmullRomCurve3 + smoothstep，
 *     速度曲线连续，且镜头有一段"惯性收尾"（lookAt 比 position 晚 12% 到达）。
 *   - 所有输入都是确定性数值（种子在 host 侧已算好），因此逐帧可重放。
 */
import * as THREE from 'three'
import type { CameraKeyframe, ShotCamera } from '../plan/types'

export function ease(name: ShotCamera['easing'], t: number): number {
  const x = Math.min(1, Math.max(0, t))
  if (name === 'linear') return x
  if (name === 'easeInOut') return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
  // smooth：smootherstep，起止二阶导也为 0，最"顺"
  return x * x * x * (x * (x * 6 - 15) + 10)
}

function v3(k: CameraKeyframe['position']): THREE.Vector3 {
  return new THREE.Vector3(k[0], k[1], k[2])
}

/** 依据运镜名决定轨道弧度（0 = 直线推拉，1 = 明显绕行）。 */
function arcAmount(move: string): number {
  const key = move.toLowerCase()
  if (key.includes('orbit')) return 1.35
  if (key.includes('crane') || key.includes('tilt')) return 0.45
  if (key.includes('pan')) return 0.35
  if (key.includes('handheld')) return 0.2
  if (key.includes('dolly')) return 0.18
  return 0.25
}

export interface CameraSample {
  position: THREE.Vector3
  lookAt: THREE.Vector3
  roll: number
}

export class CameraPath {
  private readonly positionCurve: THREE.CatmullRomCurve3
  private readonly lookCurve: THREE.CatmullRomCurve3
  private readonly rollFrom: number
  private readonly rollTo: number
  private readonly easing: ShotCamera['easing']

  constructor(shot: ShotCamera) {
    this.easing = shot.easing ?? 'smooth'
    const from = v3(shot.from.position)
    const to = v3(shot.to.position)
    const lookFrom = v3(shot.from.lookAt)
    const lookTo = v3(shot.to.lookAt)

    // 轨道中间控制点：沿"运动方向 × 视线"的侧向偏移，制造弧线而不是直线
    const dir = to.clone().sub(from)
    const view = lookFrom.clone().sub(from).normalize()
    const side = new THREE.Vector3().crossVectors(dir.clone().normalize(), view)
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
    side.normalize()
    const arc = arcAmount(shot.move) * Math.max(0.25, dir.length())
    const mid = from.clone().add(to).multiplyScalar(0.5).add(side.multiplyScalar(arc))
    // 抬一点高度，避免贴地推轨的死板感
    mid.y += Math.max(0.05, dir.length() * 0.05)

    const midLook = lookFrom.clone().add(lookTo).multiplyScalar(0.5)

    this.positionCurve = new THREE.CatmullRomCurve3([from, mid, to], false, 'catmullrom', 0.5)
    this.lookCurve = new THREE.CatmullRomCurve3([lookFrom, midLook, lookTo], false, 'catmullrom', 0.5)
    this.rollFrom = shot.from.roll ?? 0
    this.rollTo = shot.to.roll ?? 0
  }

  sample(t: number): CameraSample {
    const x = ease(this.easing, t)
    // lookAt 滞后 12%：镜头"先动头再定神"，是真实运镜的阻尼感
    const lookT = Math.min(1, Math.max(0, (t - 0.12 * t) / (1 - 0.12 * t + 1e-6)))
    return {
      position: this.positionCurve.getPoint(x),
      lookAt: this.lookCurve.getPoint(ease('smooth', lookT)),
      roll: THREE.MathUtils.lerp(this.rollFrom, this.rollTo, x),
    }
  }

  /** 机位在整段里的平均朝向，用于给空间场/雾做朝向相关的布局。 */
  averageViewDirection(): THREE.Vector3 {
    const a = this.sample(0)
    const b = this.sample(1)
    return b.lookAt.clone().sub(a.lookAt).normalize()
  }
}

/** 把一次采样写进 THREE.PerspectiveCamera（含 roll，用 up 向量实现）。 */
export function applyCameraSample(camera: THREE.PerspectiveCamera, sample: CameraSample, fov: number): void {
  camera.fov = fov
  camera.updateProjectionMatrix()
  camera.position.copy(sample.position)
  camera.up.set(0, 1, 0)
  if (Math.abs(sample.roll) > 0.001) {
    const rad = THREE.MathUtils.degToRad(sample.roll)
    camera.up.set(Math.sin(rad), Math.cos(rad), 0)
  }
  camera.lookAt(sample.lookAt)
}
