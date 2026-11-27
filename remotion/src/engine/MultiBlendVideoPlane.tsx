/**
 * 图形原语 3：MultiBlendVideoPlane —— 把 AI 视频贴到 3D 空间的任意平面/曲面上。
 *
 * 混合模式（shader 内实现，不依赖 three 的 blending 枚举，方便离线一致性）：
 *   normal / additive / multiply / lumaKey
 * 可选 chroma key（绿幕抠像），以及平面弯曲（curvature）把它变成弧形幕布。
 *
 * 视频帧永远由 Remotion 的帧号驱动（见 DeterministicVideoTexture），不做自由播放。
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import { VIDEO_PLANE_FRAG } from './glsl'
import { useDeterministicVideo } from './DeterministicVideoTexture'
import type { BlendMode } from '../plan/types'

const BLEND_INDEX: Record<BlendMode, number> = {
  normal: 0,
  additive: 1,
  multiply: 2,
  lumaKey: 3,
}

export interface MultiBlendVideoPlaneProps {
  src: string
  blend?: BlendMode
  opacity?: number
  chromaKey?: { color: string; similarity: number; smoothness: number }
  width?: number
  height?: number
  /** 弯曲：0 = 平面，>0 沿 x/y 向相机方向弯成弧形幕布 */
  curvature?: number
  position?: [number, number, number]
  rotation?: [number, number, number]
  /** 镜头内起始偏移（秒） */
  offsetSeconds?: number
  playbackRate?: number
  /** 亮度键增益 */
  lumaBoost?: number
  /** 边缘羽化宽度（UV 比例，0=硬边，0.2 左右最自然） */
  feather?: number
  segments?: number
}

export function MultiBlendVideoPlane(props: MultiBlendVideoPlaneProps): React.JSX.Element | null {
  const {
    src,
    blend = 'normal',
    opacity = 1,
    chromaKey,
    width = 16,
    height = 9,
    curvature = 0,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    offsetSeconds = 0,
    playbackRate = 1,
    lumaBoost = 0.2,
    feather = 0,
    segments = 32,
  } = props

  const { texture } = useDeterministicVideo(src, offsetSeconds, playbackRate)

  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(width, height, Math.max(1, segments), Math.max(1, Math.round(segments * (height / Math.max(width, 1)))))
    if (curvature !== 0) {
      const pos = geo.attributes.position as THREE.BufferAttribute
      for (let i = 0; i < pos.count; i += 1) {
        const x = pos.getX(i) / (width / 2)
        const y = pos.getY(i) / (height / 2)
        pos.setZ(i, -curvature * (x * x + y * y))
      }
      pos.needsUpdate = true
      geo.computeVertexNormals()
    }
    return geo
  }, [width, height, curvature, segments])

  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: VIDEO_PLANE_FRAG,
    transparent: blend !== 'multiply',
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uVideo: { value: null },
      uOpacity: { value: opacity },
      uBlend: { value: BLEND_INDEX[blend] ?? 0 },
      uUseChroma: { value: chromaKey === undefined ? 0 : 1 },
      uChromaColor: { value: new THREE.Color(chromaKey?.color ?? '#00ff00') },
      uChromaSimilarity: { value: chromaKey?.similarity ?? 0.4 },
      uChromaSmoothness: { value: chromaKey?.smoothness ?? 0.1 },
      uLumaBoost: { value: lumaBoost },
      uFeather: { value: feather },
    },
  }), [blend, opacity, chromaKey?.color, chromaKey?.similarity, chromaKey?.smoothness, lumaBoost, feather])

  if (texture === null) return null
  material.uniforms.uVideo!.value = texture

  return (
    <mesh geometry={geometry} material={material} position={position} rotation={rotation} frustumCulled={false} renderOrder={2} />
  )
}
