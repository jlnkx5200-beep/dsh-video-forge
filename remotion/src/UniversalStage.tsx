/**
 * UniversalStage —— 插件对 Remotion 的唯一入口组件。
 *
 * 职责边界很窄：拿到一份 plan（任意形状）→ 防御式解析 → 交给 ThreeCanvas + Compositor。
 * 所有"好看"的决定都在 presets/ 里，所有"通用"的能力都在 engine/ 里。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { AbsoluteFill, useVideoConfig } from 'remotion'
import { ThreeCanvas } from '@remotion/three'
import { Compositor } from './engine/Compositor'
import { parseRenderPlan } from './plan/parse'
import type { RenderPlan } from './plan/types'

export type UniversalStageProps = {
  /** RenderPlan（host 产出的 plan.json 原样传进来即可，解析器会自愈可修问题） */
  plan: unknown
  /** 覆盖背景色；不传则用 plan.style.background / fogColor */
  background?: string
  /** 关掉内置后处理（调试 shader 用） */
  disablePostFX?: boolean
}

export function UniversalStage({ plan: rawPlan, background, disablePostFX = false }: UniversalStageProps): React.JSX.Element {
  const { width, height } = useVideoConfig()

  const parsed = useMemo(() => parseRenderPlan(rawPlan), [rawPlan])

  useEffect(() => {
    for (const issue of parsed.issues) {
      const where = issue.shotId === undefined ? '' : '[' + issue.shotId + '] '
      const line = '[video-forge] ' + where + issue.message
      if (issue.level === 'error') console.error(line)
      else console.warn(line)
    }
  }, [parsed.issues])

  const bg = background ?? parsed.plan.style?.background ?? parsed.plan.style?.fogColor ?? '#05060a'

  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      <ThreeCanvas
        width={width}
        height={height}
        style={{ width, height }}
        // 离线渲染必须可读回像素；alpha 关掉避免 Remotion 合成透明底。
        // 色调映射由 COMPOSITE_FRAG 自己做（ACES + sRGB 编码），所以这里关掉 three 的
        // toneMapping，否则会"ACES 两遍"，画面发灰发闷；输出色彩空间固定 sRGB。
        gl={{
          antialias: true,
          alpha: false,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
          toneMapping: THREE.NoToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        dpr={1}
      >
        <StageInner plan={parsed.plan} width={width} height={height} disablePostFX={disablePostFX} />
      </ThreeCanvas>
    </AbsoluteFill>
  )
}

function StageInner({
  plan,
  width,
  height,
  disablePostFX,
}: {
  plan: RenderPlan
  width: number
  height: number
  disablePostFX: boolean
}): React.JSX.Element {
  return <Compositor plan={plan} width={width} height={height} disablePostFX={disablePostFX} />
}
