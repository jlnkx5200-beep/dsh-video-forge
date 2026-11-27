/**
 * 确定性视频贴图。
 *
 * 痛点：AI 生成视频（MiniMax H3 / ComfyUI 产出）塞进 Three.js 时，如果让它自由播放，
 * 离线渲染的每一帧截图会和 3D 运镜完全错位（浏览器按真实时间解码，Remotion 按帧推进）。
 *
 * 做法：
 *   1. 视频永远 paused，只允许 `currentTime = offset + frame / fps` 的精确 seek
 *   2. 每次 seek 前 `delayRender()`，`seeked` 后 `texture.needsUpdate = true` 再 `continueRender()`
 *   3. 差 < 半帧就直接复用，避免每帧都触发一次昂贵解码
 *
 * ⚠️ 门闩必须在**渲染期**挂（见 `assetLoader.ts`）：写在 useEffect 里的话 Remotion
 * 已经截完图了，成片会出现"视频永远停在第 0 帧"的经典 bug。
 */
import { useState } from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import type * as THREE from 'three'
import { acquireVideoFrame } from './assetLoader'
import { assetUrl } from './hooks'
import { useShotScope } from './CameraContext'

export interface UseDeterministicVideoResult {
  texture: THREE.Texture | null
  ready: boolean
  /** 内部用；外部一般只要 texture */
  targetSeconds: number
}

/**
 * @param src  视频路径（相对 public/ 或 http）
 * @param offsetSeconds 镜头内的起始偏移（默认 0）
 * @param playbackRate 播放速率（默认 1；用于慢动作插入）
 */
export function useDeterministicVideo(src: string | undefined, offsetSeconds = 0, playbackRate = 1): UseDeterministicVideoResult {
  const globalFrame = useCurrentFrame()
  const { fps } = useVideoConfig()
  // ⚠️ 必须用**镜头内**帧号：第 2 个镜头从第 165 帧开始，直接拿全局帧去 seek
  // 就会去要 5.5s 处的时间点，超过片长后 `seeked` 永远不触发，整条 render 卡死在
  // 那 33s 的全局超时上（2026-11-27 水墨片实测）。ShotScope 由 Compositor 逐镜头提供。
  const scope = useShotScope()
  const frame = scope.shotId === 'unknown' ? globalFrame : scope.localFrame
  // seek 完成后 Remotion 不会重渲染 React 树，需要靠这个版本号把新帧推进画面
  const [version, bump] = useState(0)
  if (src === undefined || src === '') {
    return { texture: null, ready: false, targetSeconds: 0 }
  }
  const targetSeconds = Math.max(0, offsetSeconds + (frame / fps) * playbackRate)
  const { texture, ready } = acquireVideoFrame(assetUrl(src), targetSeconds, fps, () => bump(v => v + 1))
  void version
  return { texture, ready, targetSeconds }
}

/** 直接拿到 staticFile 绝对 URL（给需要自己 set src 的场景）。 */
export function videoSrc(src: string): string {
  return assetUrl(src)
}
