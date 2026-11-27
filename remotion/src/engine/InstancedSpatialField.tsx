/**
 * 图形原语 2：InstancedSpatialField —— 大规模实例化几何 / 粒子阵列 + 大气透视雾。
 *
 * 设计要点：
 *   - 单个 InstancedMesh，所有实例矩阵在初始化时按种子一次算好（确定性，不随帧变化）
 *   - 逐实例的 seed 走 InstancedBufferAttribute，顶点着色器用它做呼吸位移与颜色变化
 *   - 雾不是 three 的 fog，而是着色器里按视空间深度 mix 雾色，可配幂次（空气厚度感）
 *   - 支持 box / tetra / plane / sphere 四种基底几何，用一行参数切换空间语汇
 */
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { FIELD_FRAG, FIELD_VERT } from './glsl'
import { useShotScope } from './CameraContext'

export type FieldShape = 'box' | 'tetra' | 'plane' | 'sphere'

export interface InstancedSpatialFieldProps {
  count?: number
  shape?: FieldShape
  /** 阵列体积（世界单位） */
  spread?: [number, number, number]
  /** 阵列中心 */
  center?: [number, number, number]
  size?: number
  sizeVariance?: number
  /** 呼吸位移幅度 */
  amplitude?: number
  fogColor?: string
  fogNear?: number
  fogFar?: number
  fogPower?: number
  baseColor?: string
  accentColor?: string
  rim?: number
  seed?: number
  /** 是否让整个阵列随镜头时间缓慢旋转（度/秒） */
  spin?: number
}

function baseGeometry(shape: FieldShape, size: number): THREE.BufferGeometry {
  if (shape === 'tetra') return new THREE.TetrahedronGeometry(size * 0.62, 0)
  if (shape === 'plane') return new THREE.PlaneGeometry(size, size, 1, 1)
  if (shape === 'sphere') return new THREE.IcosahedronGeometry(size * 0.5, 0)
  return new THREE.BoxGeometry(size, size * 0.42, size * 0.42)
}

/** 确定性 PRNG：与 host 侧 mulberry32 同构，保证同一 plan 每次渲染一致。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function InstancedSpatialField(props: InstancedSpatialFieldProps): React.JSX.Element {
  const {
    count = 900,
    shape = 'box',
    spread = [26, 10, 26],
    center = [0, -1, -8],
    size = 0.26,
    sizeVariance = 0.7,
    amplitude = 0.12,
    fogColor = '#0b1020',
    fogNear = 6,
    fogFar = 44,
    fogPower = 1.35,
    baseColor = '#101a2b',
    accentColor = '#7fa6c8',
    rim = 0.55,
    seed = 7,
    spin = 0.6,
  } = props

  const scope = useShotScope()
  const meshRef = useRef<THREE.InstancedMesh | null>(null)
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)

  const { geometry, material, instanceSeed } = useMemo(() => {
    const geo = baseGeometry(shape, size)
    const rand = mulberry32(seed >>> 0)
    const seeds = new Float32Array(Math.max(1, count) * 3)
    const matrices: THREE.Matrix4[] = []
    const dummy = new THREE.Object3D()
    for (let i = 0; i < count; i += 1) {
      const x = (rand() - 0.5) * spread[0]
      const y = (rand() - 0.5) * spread[1]
      const z = (rand() - 0.5) * spread[2]
      dummy.position.set(center[0] + x, center[1] + y, center[2] + z)
      dummy.rotation.set(rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2)
      const s = 1 + (rand() - 0.5) * sizeVariance * 2
      dummy.scale.setScalar(Math.max(0.05, s))
      dummy.updateMatrix()
      matrices.push(dummy.matrix.clone())
      seeds[i * 3] = rand()
      seeds[i * 3 + 1] = rand()
      seeds[i * 3 + 2] = rand()
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3))

    const mat = new THREE.ShaderMaterial({
      vertexShader: FIELD_VERT,
      fragmentShader: FIELD_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: amplitude },
        uPhase: { value: 0 },
        uFogColor: { value: new THREE.Color(fogColor) },
        uFogNear: { value: fogNear },
        uFogFar: { value: fogFar },
        uFogPower: { value: fogPower },
        uBaseColor: { value: new THREE.Color(baseColor) },
        uAccentColor: { value: new THREE.Color(accentColor) },
        uLightDir: { value: new THREE.Vector3(0.4, 0.8, 0.6).normalize() },
        uRim: { value: rim },
      },
    })
    mat.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
    }
    return { geometry: geo, material: mat, instanceSeed: matrices }
  }, [count, shape, spread, center, size, sizeVariance, amplitude, fogColor, fogNear, fogFar, fogPower, baseColor, accentColor, rim, seed])

  materialRef.current = material

  useFrame(state => {
    const mesh = meshRef.current
    if (mesh === null) return
    // 一次性写实例矩阵（只在首次或参数变化后）
    if (mesh.userData.__filled !== true) {
      for (let i = 0; i < instanceSeed.length; i += 1) mesh.setMatrixAt(i, instanceSeed[i]!)
      mesh.instanceMatrix.needsUpdate = true
      mesh.userData.__filled = true
    }
    const u = material.uniforms
    ;(u.uTime!.value as number) = scope.localFrame / scope.fps
    if (spin !== 0) {
      // 不能用 state.clock.elapsedTime：ThreeCanvas 的 advance() 用的是真实时钟，
      // 同一帧两次渲染会得到不同值（实测导致 0.5% 像素抖动）。一切都从 localFrame 推导。
      const seconds = scope.localFrame / Math.max(1, scope.fps)
      mesh.rotation.y = seconds * 0.0001 + (scope.progress * spin * Math.PI) / 180
    }
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, Math.max(1, count)]}
      frustumCulled={false}
    />
  )
}
