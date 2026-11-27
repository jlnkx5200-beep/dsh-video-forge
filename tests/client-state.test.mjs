/**
 * 前端纯逻辑单元测试（P2-8）：状态机 / 快照重跑保真 / 费用估算 / 请求体净化。
 *
 * 这些函数刻意做成纯函数，就是为了能在没有浏览器、没有 React、没有网络的情况下跑断言：
 * 断连判定、错误分槽、按原参数重跑、H3 与 MAGI-2 的成本差异都属于"话术容易写对、逻辑容易写错"的地方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STALE_AFTER_MS, STALE_FAILURES, appendJobEvents, buildProduceBody, canSubmit, clearError,
  formFromSnapshot, initialForm, initialState, isStale, mergeJobs, onConnectFail,
  onProduceAccepted, onStatusOk, setError,
} from '../lib/client/state.js'
import { compareEngines, estimate } from '../lib/client/cost-estimator.js'
import { sanitizeMagi2Payload } from '../lib/client/magi2-payload-sanitizer.js'
import { parseMarkdownShots, toMarkdown, toShotPayload, validateShots } from '../lib/client/shots.js'

const NOW = 1_700_000_000_000

function status(fetchedAt = NOW) {
  return {
    providers: [{ provider: 'magi2', status: 'degraded', detail: '待配额' }],
    capabilities: [],
    cache: { entries: 0, bytes: 0 },
    paths: { root: '', out: '', cache: '', plans: '', tmp: '' },
    clientId: 'test',
    ffmpeg: { path: 'ffmpeg', exists: true },
    comfyWorkflowDir: '',
    comfyWorkflows: [],
    keys: {
      ark: { present: true, hint: 'ark…1234', source: 'user-config' },
      minimax: { present: true, hint: 'sk-…1234', source: 'env' },
      sand: { present: true, hint: 'san…1234', source: 'env' },
    },
    magi2: { state: 'pending_quota', detail: '待官方配额', baseUrl: 'https://api.sand.ai', keyHint: 'san…1234', keySource: 'env', defaultDuration: 8 },
    userConfigPath: '~/.dsh/video-forge.json',
    fetchedAt,
  }
}

function job(id, overrides = {}) {
  return {
    id,
    planId: 'plan-' + id,
    title: id,
    status: 'running',
    startedAt: NOW,
    mock: false,
    dryRun: false,
    progress: { done: 0, total: 3, label: '' },
    events: [{ type: 'queued', taskId: '*', provider: '*', at: NOW, message: '已排队' }],
    issues: [],
    results: [],
    cancelable: true,
    ...overrides,
  }
}

test('P0-2 断连：刚成功时不是 stale；连续 2 次失败立刻 stale；超时也 stale', () => {
  let state = initialState()
  assert.equal(isStale(state, NOW), true, '没拿到过状态时必须是 stale')
  assert.equal(canSubmit(state, NOW), false)

  state = onStatusOk(state, status(), NOW)
  assert.equal(isStale(state, NOW), false)
  assert.equal(canSubmit(state, NOW), true)

  const failure = { kind: 'connect', title: '连不上', hint: 'Host 未启动', detail: '' }
  state = onConnectFail(state, failure, NOW + 1000)
  assert.equal(state.conn.failures, 1)
  assert.equal(isStale(state, NOW + 1000), false, '单次失败还不算断连（避免抖动）')

  state = onConnectFail(state, failure, NOW + 2000)
  assert.equal(state.conn.failures, STALE_FAILURES)
  assert.equal(isStale(state, NOW + 2000), true, '连续失败 2 次即断连')
  assert.equal(canSubmit(state, NOW + 2000), false)

  // 一次成功立刻恢复
  state = onStatusOk(state, status(NOW + 3000), NOW + 3000)
  assert.equal(isStale(state, NOW + 3000), false)

  // 时间维度：超过 15s 没更新也 stale
  assert.equal(isStale(state, NOW + 3000 + STALE_AFTER_MS + 1), true)
})

test('P0-3 错误分槽：三个槽互不覆盖，成功只清对应槽', () => {
  let state = initialState()
  const connect = { kind: 'connect', title: '连不上', hint: 'h', detail: '' }
  const submit = { kind: 'submit', title: '提交失败', hint: 'h', detail: '' }
  const config = { kind: 'config', title: '配置失败', hint: 'h', detail: '' }
  state = setError(setError(setError(state, 'connect', connect), 'submit', submit), 'config', config)
  assert.equal(state.errors.connect.title, '连不上')
  assert.equal(state.errors.submit.title, '提交失败')
  assert.equal(state.errors.config.title, '配置失败')

  state = clearError(state, 'submit')
  assert.equal(state.errors.submit, undefined)
  assert.equal(state.errors.connect.title, '连不上', '清 submit 不能顺手清掉 connect')
  assert.equal(state.errors.config.title, '配置失败')

  // /status 成功只清 connect
  state = onStatusOk(state, status(), NOW)
  assert.equal(state.errors.connect, undefined)
  assert.equal(state.errors.config.title, '配置失败')

  // 202 受理成功清 submit
  state = setError(state, 'submit', submit)
  state = onProduceAccepted(state, { jobId: 'job-1', job: job('job-1') })
  assert.equal(state.errors.submit, undefined)
})

test('P1-9 + P1-1：202 立刻锁定 jobId，事件按 cursor 增量追加且不重复', () => {
  let state = onProduceAccepted(initialState(), { jobId: 'job-9', job: job('job-9') })
  assert.equal(state.activeJobId, 'job-9')
  assert.equal(state.jobs[0].id, 'job-9')
  assert.equal(state.streams['job-9'].cursor, 1)

  const more = [{ type: 'start', taskId: 'shot-1:still', provider: 'seedream', at: NOW + 1 }]
  state = appendJobEvents(state, 'job-9', job('job-9', { status: 'running' }), more, 2)
  assert.equal(state.streams['job-9'].events.length, 2)
  assert.equal(state.streams['job-9'].cursor, 2)

  // 没有新事件时 cursor 不动、事件不重复
  state = appendJobEvents(state, 'job-9', job('job-9', { status: 'done' }), [], 2)
  assert.equal(state.streams['job-9'].events.length, 2)
  assert.equal(state.jobs[0].status, 'done')

  // mergeJobs 不重复插入同 id
  state = mergeJobs(state, [job('job-9', { status: 'done' }), job('job-10')])
  assert.equal(state.jobs.filter(item => item.id === 'job-9').length, 1)
  assert.equal(state.jobs.length, 2)
})

test('P0-1 快照重跑：只从 requestSnapshot 取值，useCache 缺失绝不默认', () => {
  const snapshot = {
    capturedAt: NOW,
    storyboard: { title: '原作业', width: 1920, height: 1080, fps: 30, preset: 'cinematic-realism', shots: [{ id: 's1', prompt: 'p', durationSec: 4 }] },
    options: {
      defaultStrategy: 'magi2-i2v', minimaxModel: 'MiniMax-H3', minimaxResolution: '768P',
      magi2Model: 'MAGI-2', magi2Duration: 12, generateAudio: false,
      qualityMode: 'draft', mock: true, dryRun: false, enablePlate: true,
    },
  }
  const restored = formFromSnapshot(snapshot)
  assert.equal(restored.form.title, '原作业')
  assert.equal(restored.form.strategy, 'magi2-i2v')
  assert.equal(restored.form.magi2Duration, 12)
  assert.equal(restored.form.generateAudio, false)
  assert.equal(restored.form.qualityMode, 'draft')
  assert.equal(restored.form.useCache, undefined, '快照里没有 useCache 就不能编一个出来')
  assert.ok(restored.missing.includes('useCache'), '缺失必须在 missing 里被点名')

  const empty = formFromSnapshot(undefined)
  assert.deepEqual(empty.form, {})
  assert.deepEqual(empty.missing, ['*'])

  // 请求体保真：策略/模型/时长/mock/useCache 一个都不许丢
  const form = { ...initialForm(), ...restored.form, useCache: false }
  const body = buildProduceBody(form, [{ id: 's1', prompt: 'p', durationSec: 4 }])
  assert.equal(body.defaultStrategy, 'magi2-i2v')
  assert.equal(body.magi2Duration, 12)
  assert.equal(body.mock, true)
  assert.equal(body.useCache, false)
  assert.equal(body.writePlan, true)
  assert.equal(Array.isArray(body.shots), true)
})

test('费用估算：MAGI-2 与 H3 必须给出可解释的差异（而不是同一个数）', () => {
  const secondsPerShot = 5
  const shots = 3
  const minimax = estimate({ shots, secondsPerShot, strategy: 'minimax-direct', minimaxResolution: '768P' })
  const magi2 = estimate({ shots, secondsPerShot, strategy: 'magi2-direct' })
  assert.equal(minimax.engine, 'minimax')
  assert.equal(magi2.engine, 'magi2')
  assert.ok(magi2.total > 0 && minimax.total > 0)
  assert.notEqual(minimax.total, magi2.total, '两个引擎不能算出同一个成本')

  const versus = compareEngines({ shots, secondsPerShot, strategy: 'minimax-direct', minimaxResolution: '768P' })
  assert.ok(['minimax', 'magi2'].includes(versus.cheaper))
  assert.equal(Math.round(Math.abs(versus.delta) * 100) / 100, Math.round(Math.abs(versus.minimax.total - versus.magi2.total) * 100) / 100)

  // Mock 必须为 0：成本纪律的第一道闸
  assert.equal(estimate({ shots, secondsPerShot, strategy: 'magi2-direct', mock: true }).total, 0)
  // 缓存命中要更便宜（同一参数下）
  const cached = estimate({ shots, secondsPerShot, strategy: 'minimax-direct', useCache: true })
  assert.ok(cached.total < minimax.total)
})

test('请求体净化：watermark/role 一律剔除，空字段 omit，非法时长与比例被拦下', () => {
  const dirty = {
    prompt: 'x',
    duration: 45,
    resolution: '720p',
    aspectRatio: '5:4',
    extra: { watermark: false, role: 'reference_image' },
    firstFrame: 'a.png',
    referenceImages: ['b.png'],
    timelineCues: [{ atSec: 1, prompt: 'later' }],
  }
  const result = sanitizeMagi2Payload(dirty)
  assert.equal(Object.hasOwn(result.payload, 'watermark'), false)
  assert.equal(Object.hasOwn(result.payload, 'role'), false)
  assert.ok(result.stripped.includes('watermark'))
  assert.equal(result.payload.duration, 30, '时长必须夹到 4–30 整数')
  assert.ok(result.stripped.includes('role'), 'role 也必须被点名剥掉')
  assert.equal(Object.hasOwn(result.payload, 'resolution'), false, '非 1080p 必须省略而不是改写')
  assert.ok(result.issues.some(issue => /resolution 仅支持/.test(issue.message)))
  assert.equal(Object.hasOwn(result.payload, 'aspect_ratio'), false, '非法比例必须省略')
  assert.equal(sanitizeMagi2Payload({ prompt: 'x', resolution: '1080p', aspectRatio: '21:9' }).payload.resolution, '1080p')
  assert.equal(result.mode, 'ark', '带 firstFrame 必须走 Ark')
  assert.ok(result.issues.some(issue => /互斥|不能混传/.test(issue.message)), '首尾帧 + 多参考必须报错')
  assert.equal(result.payload.generateAudio, undefined)
})

test('分镜：Markdown ⇄ 结构化双向同步，坏输入给出可读校验错误', () => {
  const rows = parseMarkdownShots([
    '| # | 时间 | 镜头 | 关键动效 |',
    '| --- | --- | --- | --- |',
    '| 1 | 0-4s | 全景建立 | dolly-in |',
    '| 2 | 4-9s | 中景转身 | handheld |',
  ].join('\n'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].durationSec, 4)
  assert.equal(rows[1].move, 'handheld')
  assert.match(toMarkdown(rows), /\| 2 \| 4-9s \|/)

  const payload = toShotPayload(rows)
  assert.equal(payload.length, 2)
  assert.equal(typeof payload[0].prompt, 'string')

  const bad = [{ ...rows[0], prompt: '' }]
  assert.ok(validateShots(bad).some(issue => /prompt|提示词/.test(issue.message)))

  const mixed = [{ ...rows[0], durationSec: 40, firstFrame: 'a.png', referenceImages: ['b.png'] }]
  const issues = validateShots(mixed)
  assert.ok(issues.length > 0)
})
