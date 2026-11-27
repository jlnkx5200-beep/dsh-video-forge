/**
 * HTTP 控制面契约测试（真路由、假 ctx、本地 Mock Sand.ai）。
 *
 * 为什么要这一层：单测覆盖了 Provider / Runtime / 客户端状态机，但 P0-1/P1-2/P1-9
 * 的问题根源都在**路由契约**上（202 不带 jobId、没有 cancel、plans 没有 fileKey）。
 * 这里把 `apply()` 注册出来的路由真正跑一遍，断言的就是前端实际拿到的那份 JSON。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const SAND_KEY = 'sand_test_key_0123456789abcdef'
// 测试绝不能写进用户真实的 ~/.dsh/video-forge.json：DSH_HOME 在每次 dshHome() 调用时读取，
// 所以在 import 之后、apply 之前指到临时目录即可隔离。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'vf-home-'))

/** 本地假 Sand.ai：/v1/assets 与 /v2/generations 都回 400 insufficient_credits。 */
async function startSand() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.method + ' ' + req.url)
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'insufficient_credits', message: 'no quota' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, hits, close: () => new Promise(r => server.close(r)) }
}

/** 本地假 Sand.ai：免费 GET 全 200（只能证明 Key 有效，没有任何余额信息）。 */
async function startSandOk() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.method + ' ' + req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [], account: { id: 'acc-1' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, hits, close: () => new Promise(r => server.close(r)) }
}

/** 把 apply() 注册出来的路由抓在手里，并提供一组合成 req/res 工具。 */
function makePlugin(overrides = {}) {
  const tools = new Map()
  const routes = []
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'vf-http-'))
  apply(ctx, {
    arkBaseUrl: 'http://127.0.0.1:1',
    arkApiKey: '',
    defaultSeedreamModel: '5.0-flash',
    minimaxBaseUrl: 'http://127.0.0.1:1',
    minimaxApiKey: '',
    defaultMinimaxModel: 'MiniMax-H3',
    minimaxResolution: '768P',
    comfyBaseUrl: 'http://127.0.0.1:1',
    workflowDir: '',
    dataDir,
    bridgeToken: '',
    ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
    maxConcurrent: 2,
    ...overrides,
  })
  return { tools, routes, route: routes[0] }
}

async function call(route, method, path, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  const req = Readable.from(payload === undefined ? [] : [payload])
  req.method = method
  req.url = path
  req.headers = Object.assign(
    { host: '127.0.0.1:8875', 'content-type': 'application/json' },
    payload === undefined ? {} : { 'content-length': String(payload.length) },
  )
  req.socket = { remoteAddress: '127.0.0.1' }
  const out = { status: 0, headers: {}, body: '' }
  const res = {
    statusCode: 0,
    setHeader(name, value) { out.headers[String(name).toLowerCase()] = value },
    writeHead(status) { out.status = status; return res },
    write(chunk) { out.body += chunk.toString(); return true },
    end(chunk) { if (chunk !== undefined) out.body += chunk.toString(); out.status = out.status || res.statusCode; resolve() },
  }
  let resolve
  const done = new Promise(r => { resolve = r })
  route.handler(req, res, path)
  await done
  let json
  try { json = JSON.parse(out.body) } catch { json = undefined }
  return { status: out.status, headers: out.headers, text: out.body, json }
}

test('GET /status：暴露 magi2 后端状态 + 脱敏 Sand Key + fetchedAt', async () => {
  const plugin = makePlugin()
  const res = await call(plugin.route, 'GET', '/api/dsh-video-forge/status')
  assert.equal(res.status, 200)
  assert.ok(res.json.magi2, '/status 必须带 magi2 后端状态')
  assert.equal(res.json.magi2.state, 'missing_key', '没配 Key 时必须是 missing_key')
  assert.ok(res.json.keys.sand, 'keys.sand 必须存在')
  assert.equal(res.json.keys.sand.present, false)
  assert.equal(typeof res.json.fetchedAt, 'number', '状态必须带 fetchedAt 供前端判 stale')
  assert.doesNotMatch(JSON.stringify(res.json), /sand_test_key/, '任何响应都不能回显明文 Key')
})

test('POST /magi2/probe：400 insufficient_credits → pending_quota，且提示语义准确', async () => {
  const sand = await startSand()
  try {
    const plugin = makePlugin({ sandApiKey: SAND_KEY, sandBaseUrl: sand.baseUrl })
    const res = await call(plugin.route, 'POST', '/api/dsh-video-forge/magi2/probe', {})
    assert.equal(res.status, 200)
    assert.equal(res.json.probe.state, 'pending_quota')
    // 400 是「配额不可用」的实证（不是猜），文案要说清是哪种配额状态
    assert.match(res.json.hint, /配额不可用|insufficient_credits/)
    assert.doesNotMatch(res.json.hint, /可正常生成/)
    assert.ok(sand.hits.length > 0, '探针必须真的打到 Sand.ai 免费路径')
    assert.ok(!sand.hits.some(hit => hit.includes('/v2/generations')), '探针不许打生成端点（会扣费）')
    const status = await call(plugin.route, 'GET', '/api/dsh-video-forge/status')
    assert.equal(status.json.magi2.state, 'pending_quota', '探针结果要缓存在内存并反映到 /status')
    assert.doesNotMatch(res.text + status.text, /sand_test_key/)
  } finally {
    await sand.close()
  }
})

test('POST /magi2/probe：免费 GET 200 只能说「鉴权通过」，不许说成「有配额」', async () => {
  const sand = await startSandOk()
  try {
    const plugin = makePlugin({ sandApiKey: SAND_KEY, sandBaseUrl: sand.baseUrl })
    const res = await call(plugin.route, 'POST', '/api/dsh-video-forge/magi2/probe', {})
    assert.equal(res.status, 200)
    assert.equal(res.json.probe.state, 'ready', '免费接口 200 = Key 有效，状态 ready')
    // 语义红线：探针证明不了余额，文案不能承诺「有配额 / 可正常生成」。
    assert.match(res.json.probe.detail, /待首次生成确认|无法确认余额/)
    assert.match(res.json.hint, /待首次生成确认配额/)
    assert.doesNotMatch(res.json.hint, /配额均正常|可正常生成/, '不能把 200 说成配额可用')
    assert.doesNotMatch(res.json.probe.detail, /配额可用/)
    assert.ok(!sand.hits.some(hit => hit.includes('/v2/generations')), '探针不许打生成端点（会扣费）')
    const status = await call(plugin.route, 'GET', '/api/dsh-video-forge/status')
    assert.equal(status.json.magi2.state, 'ready')
    assert.match(status.json.magi2.detail, /待首次生成确认|无法确认余额/)
  } finally {
    await sand.close()
  }
})

test('POST /produce → 202 直接带 jobId 与 job（前端不必盲猜刷新）', async () => {
  const plugin = makePlugin()
  const res = await call(plugin.route, 'POST', '/api/dsh-video-forge/produce', {
    title: '路由契约',
    mock: true,
    dryRun: true,
    shots: [{ id: 's1', shot: '全景', durationSec: 1, prompt: 'a quiet horizon' }],
  })
  assert.equal(res.status, 202)
  assert.equal(res.json.ok, true)
  assert.match(res.json.jobId, /^job-/)
  assert.equal(res.json.job.id, res.json.jobId, '202 里的 job 必须是同一个作业，不是空壳')
  assert.equal(res.json.job.mock, true)
  assert.ok(res.json.job.requestSnapshot, '作业必须回传 requestSnapshot 供重跑')
  const listed = await call(plugin.route, 'GET', `/api/dsh-video-forge/jobs?id=${res.json.jobId}`)
  assert.equal(listed.json.job.id, res.json.jobId)
  assert.equal(typeof listed.json.events.length, 'number')
  const cancel = await call(plugin.route, 'POST', `/api/dsh-video-forge/jobs/${res.json.jobId}/cancel`, {})
  assert.ok([202, 409].includes(cancel.status), `cancel 只应返回 202 或 409，实际 ${cancel.status}`)
  if (cancel.status === 409) assert.match(cancel.json.reason ?? '', /已结束/)
})

test('POST /config：白名单写入 + 掩码提示，明文 Key 永不回显', async () => {
  const plugin = makePlugin()
  const res = await call(plugin.route, 'POST', '/api/dsh-video-forge/config', {
    sandApiKey: SAND_KEY,
    sandBaseUrl: 'https://api.sand.ai',
    maxConcurrent: 8,
    evilField: 'nope',
  })
  assert.equal(res.status, 200)
  assert.ok(res.json.written.includes('sandApiKey'))
  assert.ok(res.json.rejected.some(item => String(item).includes('maxConcurrent')), 'maxConcurrent 不许热改')
  assert.ok(res.json.rejected.some(item => String(item).includes('evilField')))
  assert.equal(typeof res.json.hints.sand, 'string', 'hints.sand 只给掩码字符串')
  assert.ok(res.json.hints.sand.length > 0)
  assert.ok(!res.json.hints.sand.includes(SAND_KEY), '掩码里不能出现完整 Key')
  assert.doesNotMatch(res.text, /sand_test_key/, '写 Key 的响应不能回显 Key')
})

test('GET /plans 与 /plan/:id：每镜带可直接预览的 fileKey 映射', async () => {
  const plugin = makePlugin()
  await call(plugin.route, 'POST', '/api/dsh-video-forge/produce', {
    title: '预览契约',
    mock: true,
    dryRun: true,
    shots: [{ id: 's1', shot: '全景', durationSec: 1, prompt: 'horizon' }],
  })
  const plans = await call(plugin.route, 'GET', '/api/dsh-video-forge/plans')
  assert.equal(plans.status, 200)
  assert.ok(Array.isArray(plans.json.plans))
  assert.ok(plans.json.fetchedAt, '/plans 也要带 fetchedAt')
  if (plans.json.plans.length > 0) {
    const row = plans.json.plans[0]
    assert.ok(Array.isArray(row.preview), 'plan 行必须带 preview')
    assert.ok(row.preview.every(shot => shot.fileKeys && typeof shot.fileKeys === 'object'))
  }
})
