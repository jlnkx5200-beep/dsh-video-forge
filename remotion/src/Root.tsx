/**
 * 根组件：把 plan 注册成 Remotion Composition。
 *
 * 两级入口：
 *  1. `VideoForge` —— 读 public/forge/<planId>/plan.json（host 产出的真实 plan），
 *     面板 / Studio / CLI 都走这条。
 *  2. `Demo-*` —— 内置无资产 demo，按预设各注册一个，保证新克隆下来第一次打开 Studio 就有画面。
 */
import { Composition, staticFile } from 'remotion'
import { UniversalStage } from './UniversalStage'
import { DEMO_PLAN, VIDEO_DEMO_PLAN, demoWithPreset } from './plan/demo'
import { parseRenderPlan } from './plan/parse'
import type { RenderPlan } from './plan/types'

const DEMO_PLAN_PATH = 'forge/demo/plan.json'

/**
 * 读 plan 文件。
 *
 * ⚠️ 这里**不能** import `node:fs/promises`：Root 会被 Remotion 的 webpack 打进浏览器包，
 * 一旦静态引用 `node:` 协议就直接 `UnhandledSchemeError`（整条渲染在 bundling 阶段就挂）。
 * 所以 Node 侧（CLI 渲帧）不读盘，改由 `scripts/still.mjs` 把 plan 内容直接内联进 props；
 * 浏览器侧（Studio）走 `staticFile()` + fetch。
 */
async function readPlanFile(relPath: string): Promise<unknown | null> {
  if (typeof window === 'undefined') return null
  try {
    const res = await fetch(staticFile(relPath), { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch (error) {
    console.warn('[video-forge] 读取 plan 失败，回落内置 demo：' + relPath + ' — ' + String(error))
    return null
  }
}

export type StageCompositionProps = {
  plan: unknown
  planPath?: string
  /** 关掉后处理（排查画面问题时很有用：能看到"裸场景"长什么样） */
  disablePostFX?: boolean
  /** 覆盖背景色（默认取 plan.style.background / fogColor） */
  background?: string
}

/** calculateMetadata 让 Composition 的尺寸/时长/帧率跟着 plan 走。 */
async function calculateStageMetadata({
  props,
}: {
  props: StageCompositionProps
}): Promise<{
  durationInFrames: number
  fps: number
  width: number
  height: number
  props: StageCompositionProps
}> {
  const fromFile = await readPlanFile(props.planPath ?? DEMO_PLAN_PATH)
  const source = fromFile ?? props.plan ?? DEMO_PLAN
  const { plan, issues } = parseRenderPlan(source)
  const fatal = issues.filter(i => i.level === 'error')
  if (fatal.length > 0) {
    console.error('[video-forge] plan 存在致命问题，将渲染兜底 plan：' + fatal.map(i => i.message).join('; '))
    const fallback = parseRenderPlan(DEMO_PLAN).plan
    return {
      durationInFrames: fallback.durationInFrames,
      fps: fallback.fps,
      width: fallback.width,
      height: fallback.height,
      props: { ...props, plan: fallback },
    }
  }
  return {
    durationInFrames: plan.durationInFrames,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    props: { ...props, plan },
  }
}

/** Composition 的组件壳：把 planPath（元数据用）挡在外面，只把 plan 交给舞台。 */
function StageComponent({ plan, disablePostFX, background }: StageCompositionProps): React.JSX.Element {
  return <UniversalStage plan={plan} disablePostFX={disablePostFX} background={background} />
}

function StageComposition({
  id,
  plan,
  planPath,
}: {
  id: string
  plan: RenderPlan
  planPath?: string
}): React.JSX.Element {
  return (
    <Composition
      id={id}
      component={StageComponent}
      durationInFrames={plan.durationInFrames}
      fps={plan.fps}
      width={plan.width}
      height={plan.height}
      defaultProps={{ plan, planPath } satisfies StageCompositionProps}
      calculateMetadata={calculateStageMetadata}
    />
  )
}

export function RemotionRoot(): React.JSX.Element {
  return (
    <>
      {/* 真实 plan：host 的 writePlan() 会把 plan.json + 资产落到 public/forge/<planId>/ */}
      <StageComposition id="VideoForge" plan={DEMO_PLAN} planPath={DEMO_PLAN_PATH} />

      {/* Reference Preset 对照：同一批镜头、三套舞台，用来证明内核与风格解耦 */}
      <StageComposition id="Demo-Spatial" plan={demoWithPreset('spatial')} />
      <StageComposition id="Demo-Parallax" plan={demoWithPreset('parallax')} />
      <StageComposition id="Demo-VideoFirst" plan={demoWithPreset('video-first')} />

      {/* H3 真机片段：验证 DeterministicVideoTexture 的帧同步 */}
      <StageComposition id="Demo-VideoClip" plan={VIDEO_DEMO_PLAN} />
    </>
  )
}

export { DEMO_PLAN }
