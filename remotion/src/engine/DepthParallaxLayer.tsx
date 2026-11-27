/**
 * 图形原语 1：DepthParallaxLayer —— 消费深度图与 Alpha 遮罩的 2.5D 图层。
 *
 * 两种纵深来源叠加：
 *   a) 顶点位移：深度图在顶点着色器里采样，把平面"撑"出起伏（真几何视差，边缘会随相机移动产生位移）
 *   b) 分层错动：同一张贴图按 layers 复制成多层，每层 z 不同、UV 偏移系数不同，
 *      相机横移时层与层之间自然错开 —— 这是 2.5D 视差最"贵气"的部分
 *
 * 没有深度图时退化为 b + 亮度近似，永远不会黑屏。
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import { PARALLAX_FRAG, PARALLAX_VERT } from './glsl'
import { useDataTexture, useForgeTexture, placeholderTexture } from './hooks'
import { useCameraTelemetry } from './CameraContext'

export interface DepthParallaxLayerProps {
  src?: string
  depthSrc?: string
  matteSrc?: string
  /** 0 = 纯平面，1 = 强纵深 */
  parallax?: number
  /** 图层在空间中的 z */
  depth?: number
  /** 世界尺寸 */
  width?: number
  height?: number
  /** 额外分层数量（1 = 只有一层） */
  layers?: number
  /** 层间距（世界单位） */
  layerGap?: number
  opacity?: number
  tint?: string
  tintAmount?: number
  /** 风格化边缘强度 0..1 */
  edgeBoost?: number
  position?: [number, number, number]
  rotation?: [number, number, number]
  seed?: number
}

function useParallaxMaterial(props: DepthParallaxLayerProps): THREE.ShaderMaterial {
  const map = useForgeTexture(props.src)
  const depth = useDataTexture(props.depthSrc)
  const matte = useDataTexture(props.matteSrc)
  const fallback = useMemo(() => placeholderTexture((props.seed ?? 1) + 7, 0.4), [props.seed])
  const telemetry = useCameraTelemetry()

  return useMemo(() => {
    const material = new THREE.ShaderMaterial({
      vertexShader: PARALLAX_VERT,
      fragmentShader: PARALLAX_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uMap: { value: map ?? fallback },
        uDepth: { value: depth ?? fallback },
        uMatte: { value: matte ?? fallback },
        uHasDepth: { value: depth === null ? 0 : 1 },
        uHasMatte: { value: matte === null ? 0 : 1 },
        uParallax: { value: props.parallax ?? 0.5 },
        // 深度位移强度：默认 0.9，可用 layer.depth 微调；上限 2.4 防止位移把画面撕开
        uDepthScale: { value: Math.max(0.25, Math.min(2.4, (props.depth ?? 0) * 0.6 + 0.9)) },
        uOpacity: { value: props.opacity ?? 1 },
        uTint: { value: new THREE.Color(props.tint ?? '#ffffff') },
        uTintAmount: { value: props.tintAmount ?? 0 },
        uEdgeBoost: { value: props.edgeBoost ?? 0 },
        uCameraPos: { value: new THREE.Vector3() },
        uPlaneCenter: { value: new THREE.Vector3(...(props.position ?? [0, 0, 0])) },
        uTime: { value: 0 },
      },
    })
    material.onBeforeRender = () => {
      const u = material.uniforms
      ;(u.uCameraPos!.value as THREE.Vector3).copy(telemetry.current.position)
    }
    return material
  }, [map, depth, matte, fallback, props.parallax, props.depth, props.opacity, props.tint, props.tintAmount, props.edgeBoost, props.width, props.height, telemetry])
}

export function DepthParallaxLayer(props: DepthParallaxLayerProps): React.JSX.Element {
  const {
    width = 16,
    height = 9,
    depth = 0,
    layers = 1,
    layerGap = 0.22,
    parallax = 0.5,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    seed = 1,
  } = props
  const material = useParallaxMaterial(props)

  const geometry = useMemo(() => {
    // 顶点密度与视差强度挂钩：视差越大，位移越明显，需要更多顶点才不出现折线
    const segX = Math.min(256, Math.max(24, Math.round(64 * (0.5 + parallax))))
    const segY = Math.max(16, Math.round(segX * (height / Math.max(width, 0.001))))
    const geo = new THREE.PlaneGeometry(width, height, segX, segY)
    return geo
  }, [width, height, parallax])

  const meshes: React.JSX.Element[] = []
  const count = Math.max(1, Math.min(6, Math.round(layers)))
  for (let i = 0; i < count; i += 1) {
    const offset = (i - (count - 1) / 2) * layerGap
    const scale = 1 + i * 0.012
    meshes.push(
      <mesh
        key={i}
        geometry={geometry}
        material={material}
        position={[position[0], position[1], position[2] + depth + offset]}
        rotation={rotation}
        scale={[scale, scale, 1]}
        frustumCulled={false}
        renderOrder={i}
      />,
    )
  }
  void seed
  return <group>{meshes}</group>
}
