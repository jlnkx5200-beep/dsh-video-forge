/**
 * 资源 hooks：所有贴图/视频都从这里进来。
 *
 * ⚠️ 这些 hook **内部没有 useEffect**（原因见 `assetLoader.ts` 顶部注释）：
 * Remotion 只认渲染期同步调用的 `delayRender()`，写在 effect 里的门闩来不及生效，
 * 结果是贴图永远是占位图、视频永远是黑帧，还不报错。
 *
 * 现在的模式：渲染期取 → 没就绪就挂门闩返回 null（用占位顶一帧）→ 资源好了
 * Remotion 重渲染同一帧 → 这次直接命中缓存拿到真贴图。
 */
import { useMemo, useState } from 'react'
import { staticFile } from 'remotion'
import * as THREE from 'three'
import { acquireTexture } from './assetLoader'

export function assetUrl(src: string): string {
  if (src === '') return ''
  if (/^(https?:|data:|blob:)/i.test(src)) return src
  return staticFile(src.replace(/^\/+/, ''))
}

/** 程序化占位纹理：灰度噪声 + 轻微渐变，保证"没有资产也能出画面"。 */
export function placeholderTexture(seed = 1, tint = 0.5): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    let s = seed * 9301 + 49297
    const rand = (): number => {
      s = (s * 9301 + 49297) % 233280
      return s / 233280
    }
    const image = ctx.createImageData(size, size)
    for (let i = 0; i < image.data.length; i += 4) {
      const v = Math.floor((rand() * 0.6 + 0.2) * 255 * (0.6 + tint * 0.4))
      image.data[i] = v
      image.data[i + 1] = v
      image.data[i + 2] = Math.min(255, v + 12)
      image.data[i + 3] = 255
    }
    ctx.putImageData(image, 0, 0)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

/**
 * 静帧/视频帧等彩色贴图（sRGB）。
 *
 * `version` 是必须的：Remotion 拿到 `continueRender` 后**不会**自己重渲染 React 树，
 * 所以资源到位时要靠 `setState` 触发一次重渲染，材质才会从占位换成真贴图。
 */
export function useForgeTexture(src: string | undefined): THREE.Texture | null {
  const [version, bump] = useState(0)
  return useMemo(() => {
    if (src === undefined || src === '') return null
    return acquireTexture(assetUrl(src), false, () => bump(v => v + 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, version])
}

/** 数据贴图（深度/遮罩）：NoColorSpace，否则深度会被 sRGB 曲线掰弯。 */
export function useDataTexture(src: string | undefined): THREE.Texture | null {
  const [version, bump] = useState(0)
  return useMemo(() => {
    if (src === undefined || src === '') return null
    return acquireTexture(assetUrl(src), true, () => bump(v => v + 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, version])
}

/**
 * 加载失败时用来兜底的确定性占位纹理（按 src 哈希取种子，同一镜头每次都一样）。
 */
export function useFallbackTexture(src: string | undefined, seed = 1, tint = 0.5): THREE.Texture {
  return useMemo(() => placeholderTexture(seed, tint), [seed, tint, src])
}
