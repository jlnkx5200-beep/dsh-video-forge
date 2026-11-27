/**
 * 渲染期资源加载器（**不使用 useEffect**）。
 *
 * ── 为什么必须是渲染期 ────────────────────────────────────────────────
 * Remotion 的 `delayRender()` 只有在**渲染期同步调用**才会真正挂起这一帧：
 * 它把 handle 记进当前帧的等待集合，等所有 handle 都 `continueRender()` 后才截图。
 * 一旦写在 `useEffect` 里，第一帧已经"自认为就绪"、直接截了图，effect 再晚也来不及 ——
 * 症状就是：贴图永远是占位图 / 视频永远是黑帧，而且**不报错**（非常难查）。
 * 我们在 `@remotion/three` 的 ThreeCanvas 里实测到了这个行为（effect 里的 setState
 * 在截图时仍未生效），因此所有资源获取都改成"渲染期拿、拿不到就挂门闩、下一帧重试"。
 *
 * ── 缓存策略 ────────────────────────────────────────────────────────
 * 同一 URL 在一次 render 里只会真正加载一次；失败会被记住（记为 failed），
 * 不会每帧重复请求 404 资源。渲染进程内不 dispose 贴图：Remotion 每帧重渲染，
 * 缓存生命周期 = 进程生命周期，渲染结束进程退出，由系统回收。
 */
import * as THREE from 'three'
import { continueRender, delayRender } from 'remotion'

type Status = 'loading' | 'ready' | 'failed'

interface TextureEntry {
  status: Status
  texture: THREE.Texture | null
  /**
   * 同一张贴图可能被多个组件共用（比如预设里远/中景都指向同一张 still）。
   * 只有第一个调用者拿到 onReady 的话，其余组件永远停在占位材质上 —— 必须全员通知。
   */
  listeners: Set<() => void>
}

const textureCache = new Map<string, TextureEntry>()
/** 每个 URL 当前挂着的 delayRender handle，避免同一资源重复挂门闩。 */
const textureHandles = new Map<string, number>()

/**
 * 全局踢帧器：由 `SceneReadyKicker` 注册，资源就绪后强制 R3F 画一帧
 * （ThreeCanvas 渲染期 frameloop='never'，不踢就不重绘）。
 */
let sceneKicker: (() => void) | null = null

export function setSceneKicker(kicker: (() => void) | null): void {
  sceneKicker = kicker
}

/**
 * 放行前必须等 React 把新内容画进 canvas：
 * Remotion 的截图发生在 handle 清空之后，但**不会**替你重渲染 React 树，
 * 所以资源到位后要先 setState 让组件换材质，再等两帧 rAF 把像素画出来，最后才 continueRender。
 */
function releaseAfterPaint(handle: number): void {
  const run = (): void => continueRender(handle)
  const kick = (): void => {
    if (sceneKicker !== null) sceneKicker()
    if (typeof requestAnimationFrame === 'function') {
      // 再踢一次：第一次 advance 可能还在给 WebGL 上传贴图，第二次才是最终像素
      requestAnimationFrame(() => {
        if (sceneKicker !== null) sceneKicker()
        requestAnimationFrame(run)
      })
    } else {
      setTimeout(run, 32)
    }
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(kick)
  } else {
    setTimeout(kick, 16)
  }
}

function finishTexture(key: string): void {
  const handle = textureHandles.get(key)
  if (handle !== undefined) {
    textureHandles.delete(key)
    releaseAfterPaint(handle)
  }
}

function applyTextureSettings(tex: THREE.Texture, data: boolean): void {
  tex.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  // 颜色贴图开 mipmap + 各向异性：2K 图在斜面上被压到几像素时，不滤波就会闪成噪点。
  // 深度/遮罩这类数据贴图必须保持线性、不生成 mipmap（插值也必须是纯线性，不能混色）。
  tex.minFilter = data ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = !data
  tex.anisotropy = data ? 1 : 8
  tex.needsUpdate = true
}

/**
 * 取一张贴图；没就绪时挂门闩并返回 null（调用方用占位纹理顶一帧）。
 *
 * @param url 已经过 `assetUrl()` 处理的最终 URL
 * @param data true = 深度/遮罩等数据贴图（必须 NoColorSpace，否则被 gamma 掰弯）
 */
export function acquireTexture(url: string, data: boolean, onReady?: () => void): THREE.Texture | null {
  if (url === '') return null
  const key = (data ? 'd:' : 'c:') + url
  const entry = textureCache.get(key)
  if (entry !== undefined) {
    if (entry.status !== 'ready' && onReady !== undefined) entry.listeners.add(onReady)
    return entry.status === 'ready' ? entry.texture : null
  }
  textureCache.set(key, { status: 'loading', texture: null, listeners: new Set() })
  if (onReady !== undefined) textureCache.get(key)!.listeners.add(onReady)
  const handle = delayRender('video-forge:texture:' + url)
  textureHandles.set(key, handle)
  const settle = (status: Status, tex: THREE.Texture | null): void => {
    const listeners = textureCache.get(key)?.listeners ?? new Set<() => void>()
    textureCache.set(key, { status, texture: tex, listeners: new Set() })
    for (const notify of listeners) notify()
    finishTexture(key)
  }
  // 用 fetch + createImageBitmap 而不是 THREE.TextureLoader：
  // 在 Remotion 的 headless 渲染里，游离的 <img> 偶尔既不触发 onload 也不触发 onerror
  // （请求挂死），而 fetch 会正常返回状态码，还能顺手判断 404。
  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
      return res.blob()
    })
    .then(blob => createImageBitmap(blob))
    .then(bitmap => {
      // 直接 new THREE.Texture(bitmap) 在 headless Chrome 里上传成黑图（实测），
      // 先落到 canvas 再走 CanvasTexture，和占位纹理同一条已验证可用的路径。
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('2d context 不可用')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close?.()
      const tex = new THREE.CanvasTexture(canvas)
      applyTextureSettings(tex, data)
      settle('ready', tex)
    })
    .catch((error: unknown) => {
      settle('failed', null)
    })
  return null
}

// ── 视频 ─────────────────────────────────────────────────────────────

interface VideoEntry {
  video: HTMLVideoElement
  texture: THREE.VideoTexture
  status: Status
}

const videoCache = new Map<string, VideoEntry>()
const videoHandles = new Map<string, number>()

function finishVideo(url: string): void {
  const handle = videoHandles.get(url)
  if (handle !== undefined) {
    videoHandles.delete(url)
    continueRender(handle)
  }
}

function createVideo(url: string): VideoEntry {
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.style.position = 'fixed'
  video.style.left = '-9999px'
  video.style.width = '2px'
  video.style.height = '2px'
  video.style.opacity = '0'
  video.load()
  document.body.appendChild(video)
  const texture = new THREE.VideoTexture(video)
  // 视频纹理的 UV 原点在左上，默认 flipY=true 会把画面上下颠倒（实测 H3 出片整帧倒置）
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.anisotropy = 4
  return { video, texture, status: 'loading' }
}

/**
 * 把视频精确 seek 到目标时间；没到位就挂门闩，等 `seeked` / 超时后放行。
 * 下一帧 Remotion 会重渲染，届时 `currentTime` 已经对准，直接返回可用贴图。
 */
export function acquireVideoFrame(
  url: string,
  targetSeconds: number,
  fps: number,
  onReady?: () => void,
): { texture: THREE.Texture | null; ready: boolean } {
  if (url === '') return { texture: null, ready: false }
  let entry = videoCache.get(url)
  if (entry === undefined) {
    entry = createVideo(url)
    videoCache.set(url, entry)
  }
  // 已经判定失败（编码不支持 / 不是视频文件）就别再挂门闩重试，
  // 否则每帧 3s 会一路累积到 Remotion 的 30s 全局超时，整条渲染直接失败。
  if (entry.status === 'failed') return { texture: null, ready: false }
  const { video, texture } = entry
  // ⚠️ 所有镜头场景是**同时挂载**的（Compositor 用 portal 一次性建好），所以非当前镜头的
  // 视频组件也会每帧调用到这里。镜头越靠后，它的 localFrame 越大，一旦越过片长，
  // Chrome 会把 currentTime 钳在末尾且**不再触发 seeked**，整条 render 就卡在那 33s 超时上
  // （2026-11-27 15s 水墨片：第 301 帧 = 第 3 镜，第 2 镜的视频已被要求 seek 到 4.53s）。
  // 因此这里必须把目标时间钳进 [0, duration)，末尾留半帧余量。
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity
  const safeTarget = Math.min(Math.max(0, targetSeconds), Math.max(0, duration - 1 / Math.max(1, fps)))
  const epsilon = 0.5 / Math.max(1, fps)
  const inPosition = Math.abs(video.currentTime - safeTarget) <= epsilon
  if (video.readyState >= 2 && inPosition && entry.status === 'ready') {
    texture.needsUpdate = true
    return { texture, ready: true }
  }
  if (videoHandles.has(url)) return { texture: null, ready: false }

  const handle = delayRender('video-forge:video:' + url + '@' + safeTarget.toFixed(3))
  videoHandles.set(url, handle)
  const release = (ready: boolean): void => {
    entry!.status = ready ? 'ready' : 'failed'
    if (ready) texture.needsUpdate = true
    onReady?.()
    const handle = videoHandles.get(url)
    if (handle !== undefined) {
      videoHandles.delete(url)
      releaseAfterPaint(handle)
    }
  }
  // 3s 兜底：损坏的视频/不支持的编码不能把整条 render 卡死
  const timer = setTimeout(() => release(video.readyState >= 2), 3000)

  const seekNow = (): void => {
    const onSeeked = (): void => {
      clearTimeout(timer)
      release(true)
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    try {
      video.currentTime = safeTarget
    } catch {
      // 元数据还没到位时某些容器会抛，等 loadeddata 再来一次
      video.removeEventListener('seeked', onSeeked)
      video.addEventListener('loadeddata', () => seekNow(), { once: true })
    }
  }

  if (video.readyState >= 1) seekNow()
  else {
    video.addEventListener('loadeddata', () => seekNow(), { once: true })
    video.addEventListener('error', () => {
      clearTimeout(timer)
      release(false)
    }, { once: true })
  }
  return { texture: null, ready: false }
}

/** 清掉缓存（Studio 热更新/换 plan 时手动调用）。 */
export function resetAssetCache(): void {
  for (const entry of videoCache.values()) {
    entry.texture.dispose()
    entry.video.pause()
    entry.video.removeAttribute('src')
    entry.video.load()
    entry.video.remove()
  }
  videoCache.clear()
  textureCache.clear()
}
