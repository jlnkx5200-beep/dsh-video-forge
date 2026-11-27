/**
 * 自包含的确定性后处理链（零外部依赖）。
 *
 * 为什么不用 `postprocessing` 的 EffectComposer：
 *   本项目的合成器需要**手动接管渲染循环**（一帧内渲染两个场景到 RT 再做转场混合），
 *   而 EffectComposer 假定「一个场景 + 一个相机 + 它自己管渲染」。两套渲染循环强行共存
 *   会在 headless Chrome 下出现 RT 未清、颜色空间不一致的问题，且多一个运行时依赖。
 *   因此这里实现同语义的 PassRegistry/PassChain：可链式注册、按名字启停，
 *   与 EffectComposer 的用法一一对应（见 ComposablePostFX.tsx 的 PASS_PRESETS）。
 *
 * 所有 pass 都是全屏 quad + ShaderMaterial，链式 ping-pong，最终写屏。
 */
import * as THREE from 'three'
import { BLUR_FRAG, BRIGHT_FRAG, COMPOSITE_FRAG, FULLSCREEN_VERT, TRANSITION_FRAG } from './glsl'

export interface PostFXConfig {
  bloom: number
  bloomThreshold: number
  bloomRadius: number
  dof: number
  focus: [number, number]
  grain: number
  vignette: number
  saturation: number
  contrast: number
  exposure: number
  lift: [number, number, number]
  gain: [number, number, number]
  overlay: THREE.Texture | null
  overlayOpacity: number
  seed: number
  time: number
}

export const DEFAULT_POSTFX: PostFXConfig = {
  bloom: 0.08,
  bloomThreshold: 0.93,
  bloomRadius: 0.9,
  dof: 0,
  focus: [0.5, 0.5],
  // 默认零颗粒：人为噪点是画质红线（docs/visual-quality-standard.md），需要胶片感请显式给 film pass
  grain: 0.0,
  vignette: 0.1,
  saturation: 1.04,
  contrast: 1.08,
  exposure: 0.86,
  lift: [0.0, 0.0, 0.0],
  gain: [1.0, 1.0, 1.0],
  overlay: null,
  overlayOpacity: 1,
  seed: 0,
  time: 0,
}

export interface TransitionConfig {
  mode: number
  progress: number
  seed: number
  direction: [number, number]
  mask: THREE.Texture | null
  radialAmount: number
}

const QUAD_GEO = new THREE.PlaneGeometry(2, 2)
const QUAD_CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

class Quad {
  readonly scene = new THREE.Scene()
  readonly mesh: THREE.Mesh
  constructor(material: THREE.ShaderMaterial) {
    this.mesh = new THREE.Mesh(QUAD_GEO, material)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }
  material(): THREE.ShaderMaterial {
    return this.mesh.material as THREE.ShaderMaterial
  }
  draw(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target)
    renderer.render(this.scene, QUAD_CAM)
  }
  dispose(): void {
    this.material().dispose()
  }
}

function rt(width: number, height: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(Math.max(2, width), Math.max(2, height), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  })
  target.texture.colorSpace = THREE.NoColorSpace
  // MSAA：场景渲进 RT 后仍然要有抗锯齿，否则边缘会有阶梯（4x 在 headless 里代价可接受）
  target.samples = 4
  return target
}

/**
 * 渲染链路：
 *   sourceTex → [bright] → [blurH] → [blurV] → composite(source, bloom) → 屏
 */
export class PostChain {
  private readonly bright: Quad
  private readonly blur: Quad
  private readonly composite: Quad
  private rtBrightA: THREE.WebGLRenderTarget
  private rtBrightB: THREE.WebGLRenderTarget
  private rtTemp: THREE.WebGLRenderTarget
  private width: number
  private height: number

  constructor(renderer: THREE.WebGLRenderer, width: number, height: number) {
    const halfW = Math.max(2, Math.floor(width / 2))
    const halfH = Math.max(2, Math.floor(height / 2))
    this.width = width
    this.height = height
    this.rtBrightA = rt(halfW, halfH)
    this.rtBrightB = rt(halfW, halfH)
    this.rtTemp = rt(width, height)

    this.bright = new Quad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BRIGHT_FRAG,
      uniforms: {
        uSource: { value: null },
        uThreshold: { value: 0.72 },
        uSoftKnee: { value: 0.18 },
        uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
      },
      depthTest: false,
      depthWrite: false,
      transparent: false,
    }))

    this.blur = new Quad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        uSource: { value: null },
        uTexel: { value: new THREE.Vector2(1 / halfW, 1 / halfH) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uRadius: { value: 1.4 },
      },
      depthTest: false,
      depthWrite: false,
    }))

    this.composite = new Quad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        uSource: { value: null },
        uBloom: { value: null },
        uOverlay: { value: null },
        uUseOverlay: { value: 0 },
        uOverlayOpacity: { value: 1 },
        uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
        uBloomStrength: { value: 0.35 },
        uDof: { value: 0 },
        uFocus: { value: new THREE.Vector2(0.5, 0.5) },
        uGrain: { value: 0.035 },
        uVignette: { value: 0.22 },
        uSaturation: { value: 1.05 },
        uContrast: { value: 1.03 },
        uExposure: { value: 1 },
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uSeed: { value: 0 },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(width, height) },
      },
      depthTest: false,
      depthWrite: false,
    }))
    void renderer
  }

  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    const halfW = Math.max(2, Math.floor(width / 2))
    const halfH = Math.max(2, Math.floor(height / 2))
    this.rtBrightA.setSize(halfW, halfH)
    this.rtBrightB.setSize(halfW, halfH)
    this.rtTemp.setSize(width, height)
    ;(this.bright.material().uniforms.uTexel!.value as THREE.Vector2).set(1 / width, 1 / height)
    ;(this.blur.material().uniforms.uTexel!.value as THREE.Vector2).set(1 / halfW, 1 / halfH)
    ;(this.composite.material().uniforms.uTexel!.value as THREE.Vector2).set(1 / width, 1 / height)
    ;(this.composite.material().uniforms.uResolution!.value as THREE.Vector2).set(width, height)
  }

  /** 跑完整链路，最终写屏（target = null）。 */
  render(renderer: THREE.WebGLRenderer, source: THREE.Texture, config: PostFXConfig): void {
    const m = this.composite.material().uniforms

    // 泛光：阈值提取 → 横模糊 → 纵模糊
    if (config.bloom > 0.0001) {
      const b = this.bright.material().uniforms
      b.uSource!.value = source
      b.uThreshold!.value = config.bloomThreshold
      this.bright.draw(renderer, this.rtBrightA)

      const bl = this.blur.material().uniforms
      bl.uRadius!.value = config.bloomRadius
      bl.uSource!.value = this.rtBrightA.texture
      ;(bl.uDirection!.value as THREE.Vector2).set(1, 0)
      this.blur.draw(renderer, this.rtBrightB)

      bl.uSource!.value = this.rtBrightB.texture
      ;(bl.uDirection!.value as THREE.Vector2).set(0, 1)
      this.blur.draw(renderer, this.rtBrightA)
      m.uBloom!.value = this.rtBrightA.texture
      m.uBloomStrength!.value = config.bloom
    } else {
      m.uBloom!.value = this.rtBrightA.texture
      m.uBloomStrength!.value = 0
    }

    m.uSource!.value = source
    m.uUseOverlay!.value = config.overlay === null ? 0 : 1
    m.uOverlay!.value = config.overlay
    m.uOverlayOpacity!.value = config.overlayOpacity
    m.uDof!.value = config.dof
    ;(m.uFocus!.value as THREE.Vector2).set(config.focus[0], config.focus[1])
    m.uGrain!.value = config.grain
    m.uVignette!.value = config.vignette
    m.uSaturation!.value = config.saturation
    m.uContrast!.value = config.contrast
    m.uExposure!.value = config.exposure
    ;(m.uLift!.value as THREE.Vector3).set(config.lift[0], config.lift[1], config.lift[2])
    ;(m.uGain!.value as THREE.Vector3).set(config.gain[0], config.gain[1], config.gain[2])
    m.uSeed!.value = config.seed
    m.uTime!.value = config.time
    this.composite.draw(renderer, null)
  }

  dispose(): void {
    this.rtBrightA.dispose()
    this.rtBrightB.dispose()
    this.rtTemp.dispose()
    this.bright.dispose()
    this.blur.dispose()
    this.composite.dispose()
  }
}

/** 转场混合器：把两张 RT 合成到屏幕（或指定目标）。 */
export class TransitionMixer {
  private readonly quad: Quad
  constructor() {
    this.quad = new Quad(new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: TRANSITION_FRAG,
      uniforms: {
        uFrom: { value: null },
        uTo: { value: null },
        uMask: { value: null },
        uUseMask: { value: 0 },
        uProgress: { value: 0 },
        uSeed: { value: 0 },
        uMode: { value: 0 },
        uDirection: { value: new THREE.Vector2(-1, 0) },
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uRadialAmount: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    }))
  }

  render(
    renderer: THREE.WebGLRenderer,
    from: THREE.Texture,
    to: THREE.Texture,
    config: TransitionConfig,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    const u = this.quad.material().uniforms
    u.uFrom!.value = from
    u.uTo!.value = to
    u.uMask!.value = config.mask
    u.uUseMask!.value = config.mask === null ? 0 : 1
    u.uProgress!.value = config.progress
    u.uSeed!.value = config.seed
    u.uMode!.value = config.mode
    ;(u.uDirection!.value as THREE.Vector2).set(config.direction[0], config.direction[1])
    u.uRadialAmount!.value = config.radialAmount
    this.quad.draw(renderer, target)
  }

  dispose(): void {
    this.quad.dispose()
  }
}

/** 场景 → RT 的一次渲染（含清屏与清深度）。 */
export function renderSceneToTarget(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.WebGLRenderTarget,
  background: THREE.Color | null,
): void {
  const previousAutoClear = renderer.autoClear
  renderer.autoClear = true
  if (background !== null) {
    if (scene.background instanceof THREE.Color) scene.background.copy(background)
    else scene.background = background.clone()
  }
  renderer.setRenderTarget(target)
  renderer.clear(true, true, true)
  renderer.render(scene, camera)
  renderer.autoClear = previousAutoClear
}

/** 跳过整条后处理链：直接渲到屏幕（调试 shader / 排查后处理黑屏时用）。 */
export function renderSceneToScreen(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  background: THREE.Color | null,
): void {
  const previousAutoClear = renderer.autoClear
  renderer.autoClear = true
  if (background !== null) {
    if (scene.background instanceof THREE.Color) scene.background.copy(background)
    else scene.background = background.clone()
  }
  renderer.setRenderTarget(null)
  renderer.clear(true, true, true)
  renderer.render(scene, camera)
  renderer.autoClear = previousAutoClear
}

export function makeRenderTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return rt(width, height)
}
