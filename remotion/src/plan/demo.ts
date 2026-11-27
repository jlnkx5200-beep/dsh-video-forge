/**
 * 无资产 Demo plan：不依赖任何生成产物，第一次打开 Studio 就该看到东西。
 *
 * 素材 src 指向 `forge/demo/` 下并不存在的文件 —— 这是故意的：
 * 引擎的 useForgeTexture 会回落到程序化占位纹理，于是"没有任何生成产物"也能出画面。
 * 等 host 真正跑过一次管线，public/forge/demo/ 有真资产时，同名文件会自然接管。
 */
import type { RenderPlan } from './types'

const PLACEHOLDER = 'forge/demo/still.jpg'

export const DEMO_PLAN: RenderPlan = {
  version: 1,
  id: 'demo-builtin',
  title: 'Video Forge · 内置 Demo',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 240,
  preset: 'spatial',
  style: {
    tags: ['cinematic', 'cool'],
    palette: ['#0d1626', '#8fb4d6', '#d8e6f2'],
    fogColor: '#070a12',
    background: '#070a12',
  },
  shots: [
    {
      id: 's1',
      index: 0,
      from: 0,
      durationInFrames: 90,
      strategy: 'still-3d',
      shotSize: 'wide',
      description: '镜头一：阵列中推入，雾把远处吃掉',
      camera: {
        move: 'dolly-in',
        from: { position: [0, 1.2, 6], lookAt: [0, 0.6, -8] },
        to: { position: [0, 1.0, -2], lookAt: [0, 0.4, -14] },
        fov: 42,
        easing: 'smooth',
      },
      layer: { src: PLACEHOLDER, parallax: 0.3, depth: 0 },
      postFX: [],
      transitionOut: { type: 'crossfade', durationInFrames: 18 },
      assets: { still: PLACEHOLDER },
    },
    {
      id: 's2',
      index: 1,
      from: 90,
      durationInFrames: 90,
      strategy: 'still-3d',
      shotSize: 'medium',
      description: '镜头二：横移，近景粒子掠过',
      camera: {
        move: 'pan',
        from: { position: [-4, 1.6, -4], lookAt: [0, 0.8, -12] },
        to: { position: [4, 1.4, -4], lookAt: [0, 0.8, -12] },
        fov: 38,
        easing: 'linear',
      },
      layer: { src: PLACEHOLDER, parallax: 0.55, depth: 0.1 },
      postFX: ['bloom'],
      transitionIn: { type: 'crossfade', durationInFrames: 18 },
      transitionOut: { type: 'noise-dissolve', durationInFrames: 20 },
      assets: { still: PLACEHOLDER },
    },
    {
      id: 's3',
      index: 2,
      from: 180,
      durationInFrames: 60,
      strategy: 'still-3d',
      shotSize: 'close',
      description: '镜头三：拉远收尾',
      camera: {
        move: 'dolly-out',
        from: { position: [0.5, 2.2, -3], lookAt: [0, 0.6, -10] },
        to: { position: [0, 3.4, 12], lookAt: [0, 0.4, -16] },
        fov: 46,
        easing: 'smooth',
      },
      layer: { src: PLACEHOLDER, parallax: 0.2, depth: 0 },
      postFX: [],
      transitionIn: { type: 'noise-dissolve', durationInFrames: 20 },
      assets: { still: PLACEHOLDER },
    },
  ],
  provenance: { source: 'builtin-demo' },
  createdAt: '2026-01-01T00:00:00.000Z',
}

/** 同一批镜头换预设，用来在 Studio 里直观对比"内核不变、风格全变"。 */
export function demoWithPreset(preset: string): RenderPlan {
  return {
    ...DEMO_PLAN,
    id: 'demo-' + preset,
    title: 'Video Forge · Demo (' + preset + ')',
    preset,
    shots: DEMO_PLAN.shots.map(s => ({ ...s, assets: { ...s.assets } })),
  }
}

/**
 * 视频帧同步 Demo：直接吃一次 MiniMax H3 的真实产出（public/forge/videotest/clip.mp4）。
 *
 * 这个 Composition 存在的唯一目的就是肉眼验证 <DeterministicVideoTexture>：
 * 在 Studio 里拖动时间轴，视频应该逐帧咬合、不会"自由播放"，同一帧重复渲染像素完全一致。
 * 换成自己的片子：把 mp4 丢进 public/forge/videotest/clip.mp4，或在 host 跑一次
 * produce({ strategy: 'minimax-direct' }) 让 plan 自动指向真实产出。
 */
export const VIDEO_DEMO_PATH = 'forge/videotest/demo-video.json'

export const VIDEO_DEMO_PLAN: RenderPlan = {
  version: 1,
  id: 'demo-video-clip',
  title: 'Video Forge · Demo (H3 视频帧同步)',
  width: 1280,
  height: 720,
  fps: 24,
  durationInFrames: 96,
  preset: 'video-first',
  style: {
    tags: ['cinematic', 'real'],
    palette: ['#0d1626', '#8fb4d6', '#d8e6f2'],
    fogColor: '#0a0f16',
    background: '#070a12',
  },
  shots: [
    {
      id: 'v1',
      index: 0,
      from: 0,
      durationInFrames: 96,
      strategy: 'minimax-direct',
      shotSize: 'wide',
      description: 'H3 直出片段：雾中林道，静态机位（验证帧同步，不掺运镜）',
      camera: {
        move: 'static',
        from: { position: [0, 0, 4], lookAt: [0, 0, 0] },
        to: { position: [0, 0, 4], lookAt: [0, 0, 0] },
        fov: 47,
        easing: 'linear',
      },
      video: { src: 'forge/videotest/clip.mp4', blend: 'normal', opacity: 1, width: 22, height: 12.4 },
      postFX: [],
      assets: { video: 'forge/videotest/clip.mp4' },
    },
  ],
  provenance: { source: 'builtin-demo', note: 'MiniMax H3 480P 4s 真机产出' },
  createdAt: '2026-01-01T00:00:00.000Z',
}
