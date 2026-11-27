/**
 * 转场求解：plan 里的字符串 → 混合器 mode + 方向。
 * 与 host 侧 compiler 的归一化保持一致（crossfade / radial-blur / luma-wipe / noise-dissolve / push）。
 */
import type { ShotTransition } from '../plan/types'

export const TRANSITION_MODES = ['crossfade', 'radial-blur', 'luma-wipe', 'noise-dissolve', 'push'] as const
export type TransitionMode = typeof TRANSITION_MODES[number]

export function transitionMode(type: string | undefined): number {
  if (type === undefined) return 0
  const index = TRANSITION_MODES.findIndex(mode => type.toLowerCase().includes(mode))
  return index < 0 ? 0 : index
}

export function transitionDirection(direction: ShotTransition['direction']): [number, number] {
  if (direction === 'right') return [1, 0]
  if (direction === 'up') return [0, 1]
  if (direction === 'down') return [0, -1]
  return [-1, 0]
}

/** 转场时长（帧）→ 归一化进度 */
export function transitionProgress(frame: number, startFrame: number, durationInFrames: number): number {
  if (durationInFrames <= 0) return 1
  const t = (frame - startFrame) / durationInFrames
  return Math.min(1, Math.max(0, t))
}

/** 转场期间是否需要两路渲染（所有内置转场都要）。 */
export function needsDualPass(type: string | undefined): boolean {
  return type !== undefined && type !== ''
}
