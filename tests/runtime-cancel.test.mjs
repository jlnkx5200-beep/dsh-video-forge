/**
 * 真取消链路 + pending_quota 作业态（C1 / P1-2 后端根基）。
 *
 * 用一个"永远不返回、只认 AbortSignal"的假 Provider 顶替 mock，
 * 验的是 scheduler → runtime → job 状态这条链真的会断，而不是只把按钮做出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForgeRuntime } from '../lib/core/runtime.js'
import { ensureDirs } from '../lib/core/config.js'
import { ForgeError, PENDING_QUOTA_CODE } from '../lib/core/providers/types.js'

const HOME = mkdtempSync(join(tmpdir(), 'vf-runtime-'))
const paths = ensureDirs(join(HOME, 'data'))

function makeRuntime() {
  return new ForgeRuntime({
    config: () => ({
      arkBaseUrl: 'http://127.0.0.1:1',
      arkApiKey: '',
      defaultSeedreamModel: '5.0-flash',
      minimaxBaseUrl: 'http://127.0.0.1:1',
      minimaxApiKey: '',
      defaultMinimaxModel: 'MiniMax-H3',
      minimaxResolution: '768P',
      sandBaseUrl: 'http://127.0.0.1:1',
      sandApiKey: '',
      defaultMagi2Duration: 8,
      comfyBaseUrl: 'http://127.0.0.1:1',
      workflowDir: join(HOME, 'workflows'),
      outputDir: paths.outDir,
      bridgeToken: '',
      ffmpegPath: 'ffmpeg',
    }),
    paths: () => paths,
    pluginRoot: HOME,
    eventBuffer: 200,
  })
}

const storyboard = {
  id: 'plan-cancel-test',
  title: '取消链路',
  width: 1920,
  height: 1080,
  fps: 30,
  preset: 'cinematic-realism',
  style: { tags: [] },
  shots: [{ id: 'shot-1', shot: '全景', durationSec: 4, prompt: 'a monolith under rain' }],
}

test('runtime.cancelJob 能中止进行中的调度任务，并把作业置为 cancelled', async () => {
  const runtime = makeRuntime()
  let observedAbort = false
  runtime.providers.register({
    id: 'mock',
    label: 'hanging',
    capabilities: () => [{ kind: 'image' }, { kind: 'video' }, { kind: 'asset' }],
    health: () => ({ provider: 'mock', status: 'ok', detail: 'fake', checkedAt: Date.now() }),
    run: async (request, ctx) => {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          observedAbort = true
          reject(new ForgeError('已取消', false, undefined, 'cancelled'))
        }
        if (ctx.signal?.aborted === true) {
          onAbort()
          return
        }
        ctx.signal?.addEventListener('abort', onAbort, { once: true })
        const timer = setTimeout(resolve, 30_000)
        if (typeof timer.unref === 'function') timer.unref()
      })
      return { ok: true, taskId: request.id, provider: 'mock', artifacts: [], seconds: 0, cached: false, warnings: [] }
    },
  })

  const pending = runtime.produce(storyboard, { mock: true, useCache: false, writePlan: false, concurrency: 2 })
  const job = runtime.listJobs(5)[0]
  assert.ok(job !== undefined, '作业必须立刻可见（202 才能锁定 jobId）')
  assert.equal(job.status, 'running')

  const cancelled = runtime.cancelJob(job.id)
  assert.equal(cancelled.ok, true)

  const finished = await pending
  assert.equal(observedAbort, true, 'Provider 必须真的收到 abort')
  assert.equal(finished.status, 'cancelled')
  assert.ok(finished.events.some(event => /取消/.test(event.message ?? '')), '必须写入取消事件')
  assert.equal(runtime.getJob(job.id).status, 'cancelled')
})

test('cancelJob 对已结束作业给出 409 语义，对不存在作业给出 404 语义', async () => {
  const runtime = makeRuntime()
  runtime.providers.register({
    id: 'mock',
    label: 'instant',
    capabilities: () => [{ kind: 'image' }],
    health: () => ({ provider: 'mock', status: 'ok', detail: 'fake', checkedAt: Date.now() }),
    run: async (request, ctx) => {
      const artifact = ctx.save('mock', request.id + '.png', Buffer.from('x'), { kind: 'image' })
      return { ok: true, taskId: request.id, provider: 'mock', artifacts: [artifact], seconds: 0, cached: false, warnings: [] }
    },
  })
  const done = await runtime.produce(storyboard, { mock: true, useCache: false, writePlan: false })
  const second = runtime.cancelJob(done.id)
  assert.equal(second.ok, false)
  assert.match(String(second.reason), /已结束/)
  const missing = runtime.cancelJob('job-does-not-exist')
  assert.equal(missing.ok, false)
  assert.match(String(missing.reason), /作业不存在/)
})

test('pending_quota：作业进入 pending_quota 且完整保留 requestSnapshot 供重放', async () => {
  const runtime = makeRuntime()
  runtime.providers.register({
    id: 'mock',
    label: 'quota',
    capabilities: () => [{ kind: 'image' }],
    health: () => ({ provider: 'mock', status: 'ok', detail: 'fake', checkedAt: Date.now() }),
    run: async () => {
      throw new ForgeError('Sand.ai 官方配额未下发（400 insufficient_credits）', false, { httpStatus: 400 }, PENDING_QUOTA_CODE)
    },
  })

  const job = await runtime.produce(storyboard, { mock: true, useCache: false, writePlan: false, defaultStrategy: 'seedream-static' })
  assert.equal(job.status, 'pending_quota')
  assert.ok(job.pendingQuota !== undefined)
  assert.equal(job.pendingQuota.error.includes('insufficient_credits') || job.pendingQuota.error.includes('配额'), true)
  assert.ok(job.requestSnapshot !== undefined, 'pending_quota 必须保留可重放草稿')
  assert.equal(job.requestSnapshot.storyboard.title, '取消链路')
  assert.equal(job.requestSnapshot.options.mock, true)
  // 取消一个已结束的作业不该把它变回 running
  assert.equal(runtime.cancelJob(job.id).ok, false)
})
