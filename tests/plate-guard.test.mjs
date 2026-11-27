/**
 * 背景板守卫（P1-1）：matte 前景占比过低（< 1.5%）或过高（> 92%，整图被判成前景）时都不能采用 plate。
 *
 * 两段验证：
 *   1) 纯函数：alpha 覆盖率读得准、坏数据不让它误判（返回 null 而不是 0）；
 *   2) 集成：真跑一次 comfy-pipeline，让 comfyui 回一张「全透明 matte」，
 *      断言作业里 plate 被摘掉、warn 落进 issues、provenance 留下测量记录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForgeRuntime } from '../lib/core/runtime.js'
import { ensureDirs } from '../lib/core/config.js'
import { alphaCoverage, decodePngAlpha } from '../lib/core/png.js'
import { rgbaPng } from './_png.mjs'

test('decodePngAlpha / alphaCoverage：算得准，也拒绝看不懂的输入', () => {
  const half = rgbaPng(8, 8, (x) => (x < 4 ? 255 : 0))
  const image = decodePngAlpha(half)
  assert.equal(image.width, 8)
  assert.equal(image.height, 8)
  assert.equal(image.alpha.length, 64)

  const dir = mkdtempSync(join(tmpdir(), 'vf-alpha-'))
  const path = join(dir, 'half.png')
  writeFileSync(path, half)
  assert.equal(alphaCoverage(path), 0.5)

  const clearPath = join(dir, 'clear.png')
  writeFileSync(clearPath, rgbaPng(4, 4, () => 0))
  assert.equal(alphaCoverage(clearPath), 0)

  // 读不出来时必须返回 null（保守：不删 plate），而不是 0（激进：误删）
  assert.equal(alphaCoverage(join(dir, 'missing.png')), null)
  const junkPath = join(dir, 'junk.png')
  writeFileSync(junkPath, Buffer.from('not a png at all'))
  assert.equal(decodePngAlpha(readFileSync(junkPath)), null)
  assert.equal(alphaCoverage(junkPath), null)
})

const HOME = mkdtempSync(join(tmpdir(), 'vf-plate-'))
const paths = ensureDirs(join(HOME, 'data'))

function makeRuntime() {
  return new ForgeRuntime({
    config: () => ({
      arkBaseUrl: 'http://127.0.0.1:1', arkApiKey: '', defaultSeedreamModel: '5.0-flash',
      minimaxBaseUrl: 'http://127.0.0.1:1', minimaxApiKey: '', defaultMinimaxModel: 'MiniMax-H3',
      minimaxResolution: '768P', sandBaseUrl: 'http://127.0.0.1:1', sandApiKey: '', defaultMagi2Duration: 8,
      comfyBaseUrl: 'http://127.0.0.1:1', workflowDir: join(HOME, 'workflows'), outputDir: paths.outDir,
      bridgeToken: '', ffmpegPath: 'ffmpeg',
    }),
    paths: () => paths,
    pluginRoot: HOME,
    eventBuffer: 200,
  })
}

function fakeProvider(id, make) {
  return {
    id,
    label: 'fake-' + id,
    capabilities: () => [{ kind: 'image' }, { kind: 'video' }, { kind: 'asset' }],
    health: () => ({ provider: id, status: 'ok', detail: 'fake', checkedAt: Date.now() }),
    run: async (request, ctx) => {
      const bytes = make(request, ctx)
      const kind = request.kind === 'video' ? 'video' : 'image'
      const artifact = ctx.save(id, request.id.replace(/[^\w.-]+/g, '_') + (kind === 'video' ? '.mp4' : '.png'), bytes, { kind })
      return { ok: true, taskId: request.id, provider: id, artifacts: [artifact], seconds: 0, cached: false, warnings: [] }
    },
  }
}

test('背景板守卫：全透明 matte → plate 被摘掉并留下 warn，而不是交付黑孔图', async () => {
  const runtime = makeRuntime()
  const transparentMatte = rgbaPng(16, 16, () => 0)
  const opaque = rgbaPng(16, 16, () => 255)

  runtime.providers.register(fakeProvider('seedream', () => opaque))
  runtime.providers.register(fakeProvider('minimax', () => Buffer.from('fake-mp4')))
  runtime.providers.register(fakeProvider('comfyui', request => {
    const workflow = String(request.params?.workflowName ?? '')
    if (workflow.includes('matte')) return transparentMatte
    return opaque
  }))

  const job = await runtime.produce({
    id: 'plan-plate-guard',
    title: '背景板守卫',
    width: 960,
    height: 540,
    fps: 24,
    preset: 'cinematic-realism',
    style: { tags: [] },
    shots: [{ id: 'shot-1', shot: '全景', durationSec: 4, prompt: 'an empty horizon, no subject at all' }],
  }, {
    defaultStrategy: 'comfy-pipeline',
    enablePlate: true,
    matteWorkflow: 'dsh-matte-v2.api.json',
    plateWorkflow: 'dsh-plate.api.json',
    depthWorkflow: 'dsh-depth-v2.api.json',
    useCache: false,
    writePlan: true,
    qualityMode: 'production',
  })

  assert.equal(job.status, 'done', '守卫是降级而不是失败：作业仍应完成')
  const warn = job.issues.find(issue => /已跳过背景板/.test(issue.message ?? ''))
  assert.ok(warn !== undefined, '必须留下「跳过背景板」的 warn')
  assert.equal(warn.level, 'warn')

  const plan = JSON.parse(readFileSync(String(job.planJsonPath), 'utf8'))
  assert.equal(plan.shots[0].assets.plate, undefined, '低覆盖率时 plate 必须从计划里摘掉')
  assert.ok(Array.isArray(plan.provenance?.plateGuard), '测量结果要写进 provenance 便于复盘')
  assert.equal(plan.provenance.plateGuard[0].kept, false)
})

test('背景板守卫上界：整图被判成前景（覆盖率 > 92%）同样摘 plate', async () => {
  const runtime = makeRuntime()
  // BiRefNet 在「无主体风景」上的典型失败：整张图都被判成前景 → 覆盖率接近 100%，
  // 这时「背景板」是整图补洞后的黑洞，比黑孔更糟，必须与下界一样摘掉。
  const fullMatte = rgbaPng(16, 16, () => 255)
  const opaque = rgbaPng(16, 16, () => 255)

  runtime.providers.register(fakeProvider('seedream', () => opaque))
  runtime.providers.register(fakeProvider('minimax', () => Buffer.from('fake-mp4')))
  runtime.providers.register(fakeProvider('comfyui', request => {
    const workflow = String(request.params?.workflowName ?? '')
    if (workflow.includes('matte')) return fullMatte
    return opaque
  }))

  const job = await runtime.produce({
    id: 'plan-plate-guard-high',
    title: '背景板守卫上界',
    width: 960,
    height: 540,
    fps: 24,
    preset: 'cinematic-realism',
    style: { tags: [] },
    shots: [{ id: 'shot-1', shot: '全景', durationSec: 4, prompt: 'a landscape where everything is foreground' }],
  }, {
    defaultStrategy: 'comfy-pipeline',
    enablePlate: true,
    matteWorkflow: 'dsh-matte-v2.api.json',
    plateWorkflow: 'dsh-plate.api.json',
    depthWorkflow: 'dsh-depth-v2.api.json',
    useCache: false,
    writePlan: true,
    qualityMode: 'production',
  })

  assert.equal(job.status, 'done', '上界命中同样是降级而不是失败')
  const warn = job.issues.find(issue => /已跳过背景板/.test(issue.message ?? ''))
  assert.ok(warn !== undefined, '必须留下「跳过背景板」的 warn')
  assert.match(warn.message, /高于上界/, '上界命中的文案要写明是「高于上界」，别和下界混用')
  assert.match(warn.message, /92\.0%/, '阈值要出现在文案里，便于现场判断')

  const plan = JSON.parse(readFileSync(String(job.planJsonPath), 'utf8'))
  assert.equal(plan.shots[0].assets.plate, undefined, '全前景时 plate 必须被摘掉')
  assert.equal(plan.provenance.plateGuard[0].kept, false)
  assert.ok(plan.provenance.plateGuard[0].coverage > 0.92, '覆盖率要如实记录，便于复盘阈值')
})
