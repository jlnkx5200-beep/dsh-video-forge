/**
 * 渲染侧契约解析的单测（P1-7）：渲染进程是最容易"静默降级"的地方。
 *
 * 直接 import remotion/src/plan/parse.ts —— 它只有 `import type`，
 * Node 24 的类型剥离足以把它当 ESM 跑起来，不必先编译 remotion 工程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRenderPlan } from '../remotion/src/plan/parse.ts'
import { isVideoStrategy, VIDEO_STRATEGIES } from '../remotion/src/plan/types.ts'

function baseShot(overrides = {}) {
  return {
    id: 'shot-1',
    index: 0,
    from: 0,
    durationInFrames: 60,
    strategy: 'seedream-static',
    camera: { move: 'dolly-in', from: { position: [0, 1.5, 5] }, to: { position: [0, 1.4, 2] }, fov: 40 },
    layer: { src: 'a.png', parallax: 0.5, depth: 0 },
    postFX: [],
    assets: {},
    ...overrides,
  }
}

function planWith(shot) {
  return { version: 1, id: 'plan-parse', title: 't', width: 1920, height: 1080, fps: 30, durationInFrames: 60, preset: 'cinematic-realism', style: { tags: [] }, shots: [shot] }
}

test('未知 strategy 回退 seedream-static 并留 warn（不静默）', () => {
  const parsed = parseRenderPlan(planWith(baseShot({ strategy: 'totally-new-engine' })))
  assert.equal(parsed.plan.shots[0].strategy, 'seedream-static')
  assert.ok(parsed.issues.some(i => i.level === 'warn' && /未知 strategy/.test(i.message)))
})

test('minimax-2k-repaint / magi2-* 都被认作 video 策略，历史拼写 luakay 归一为 lumaKey', () => {
  for (const strategy of VIDEO_STRATEGIES) assert.equal(isVideoStrategy(strategy), true, strategy)
  assert.equal(isVideoStrategy('seedream-static'), false)
  assert.equal(VIDEO_STRATEGIES.includes('minimax-2k-repaint'), true)

  const parsed = parseRenderPlan(planWith(baseShot({
    strategy: 'minimax-2k-repaint',
    layer: undefined,
    video: { src: 'v.mp4', blend: 'luakay', opacity: 1 },
  })))
  assert.equal(parsed.plan.shots[0].video.blend, 'lumaKey')
  assert.equal(parsed.issues.filter(i => i.level === 'error').length, 0, '这些都不该是结构性错误')
})

test('结构性问题才报 error：空镜头列表 / 缺图层与视频', () => {
  const empty = parseRenderPlan({ version: 1, shots: [] })
  assert.ok(empty.issues.some(i => i.level === 'error' && /没有任何镜头/.test(i.message)))
  assert.equal(empty.plan.shots.length, 0)

  const bare = parseRenderPlan(planWith(baseShot({ layer: undefined, video: undefined })))
  assert.ok(bare.issues.some(i => i.level === 'error' && /图层|视频/.test(i.message)), '既无图层也无视频必须报错')
})

test('camera / fov / 时长自愈：缺值有默认，越界被夹紧', () => {
  const parsed = parseRenderPlan(planWith(baseShot({ camera: { fov: 999 }, durationInFrames: 0 })))
  const shot = parsed.plan.shots[0]
  assert.ok(shot.camera.fov > 0 && shot.camera.fov < 180, 'fov 必须落在 (0,180)')
  assert.equal(Array.isArray(shot.camera.from.position), true)
  assert.ok(shot.durationInFrames >= 1, '时长不能是 0 帧')
  assert.equal(parsed.plan.width, 1920)
})
