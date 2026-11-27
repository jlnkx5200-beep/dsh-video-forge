/**
 * 并发分池（P1-5）：ComfyUI 只有一个实例、8GB 显存跑不了两路同时推理，
 * 但 API 侧（Seedream / H3 / Sand.ai）完全可以并行。分池的本质是"别互相堵"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Scheduler } from '../lib/core/scheduler.js'
import { ForgeCache } from '../lib/core/cache.js'
import { ensureDirs } from '../lib/core/config.js'

const HOME = mkdtempSync(join(tmpdir(), 'vf-pools-'))
const paths = ensureDirs(join(HOME, 'data'))

function makeScheduler(tracked, options = {}) {
  const cache = new ForgeCache(paths.cacheDir)
  const providers = new Map()
  const provider = id => ({
    id,
    label: id,
    capabilities: () => [{ kind: 'image' }],
    health: () => ({ provider: id, status: 'ok', detail: 'fake', checkedAt: Date.now() }),
    run: async request => {
      const slot = tracked[id]
      slot.active += 1
      slot.max = Math.max(slot.max, slot.active)
      await new Promise(resolve => setTimeout(resolve, 40))
      slot.active -= 1
      return { ok: true, taskId: request.id, provider: id, artifacts: [], seconds: 0, cached: false, warnings: [] }
    },
  })
  for (const id of ['comfyui', 'seedream']) providers.set(id, provider(id))
  return new Scheduler({
    registry: {
      has: id => providers.has(id),
      require: id => {
        const found = providers.get(id)
        if (found === undefined) throw new Error('未知 Provider：' + id)
        return found
      },
    },
    cache,
    config: () => ({
      arkBaseUrl: '', arkApiKey: '', defaultSeedreamModel: '5.0-flash',
      minimaxBaseUrl: '', minimaxApiKey: '', defaultMinimaxModel: 'MiniMax-H3', minimaxResolution: '768P',
      sandBaseUrl: '', sandApiKey: '', defaultMagi2Duration: 8,
      comfyBaseUrl: '', workflowDir: join(HOME, 'workflows'), outputDir: paths.outDir,
      bridgeToken: '', ffmpegPath: 'ffmpeg',
    }),
    saveArtifact: (sub, fileName, bytes, meta) => ({
      id: sub + '/' + fileName, kind: meta?.kind ?? 'asset', path: join(paths.outDir, sub, fileName),
      url: '/api/dsh-file', fileKey: 'o/' + sub + '/' + fileName, bytes: bytes.length,
    }),
    tmpDir: paths.tmpDir,
    useCache: false,
    concurrency: 4,
    ...options,
  })
}

test('GPU 池默认串行（comfyui 最多 1 路），API 池仍然并行', async () => {
  const tracked = { comfyui: { active: 0, max: 0 }, seedream: { active: 0, max: 0 } }
  const scheduler = makeScheduler(tracked, { gpuConcurrency: 1 })

  const tasks = [
    { id: 'a:depth', provider: 'comfyui', kind: 'image', params: {} },
    { id: 'b:depth', provider: 'comfyui', kind: 'image', params: {} },
    { id: 'c:still', provider: 'seedream', kind: 'image', params: {} },
    { id: 'd:still', provider: 'seedream', kind: 'image', params: {} },
  ]
  const run = await scheduler.run(tasks)
  assert.equal(run.stats.failed, 0)
  assert.equal(tracked.comfyui.max, 1, 'ComfyUI 必须串行（单实例 + 8GB 显存）')
  assert.ok(tracked.seedream.max >= 2, 'API 侧不该被 GPU 池堵住，应该并行：' + tracked.seedream.max)
  assert.equal(run.stats.ok, 4)
})

test('调大 gpuConcurrency 才允许 ComfyUI 并行（显式选择，不默认）', async () => {
  const tracked = { comfyui: { active: 0, max: 0 }, seedream: { active: 0, max: 0 } }
  const scheduler = makeScheduler(tracked, { gpuConcurrency: 2 })
  await scheduler.run([
    { id: 'a:depth', provider: 'comfyui', kind: 'image', params: {} },
    { id: 'b:depth', provider: 'comfyui', kind: 'image', params: {} },
  ])
  assert.equal(tracked.comfyui.max, 2)
})
