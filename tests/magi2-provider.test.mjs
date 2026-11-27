/**
 * MAGI-2 Provider × 本地 Mock Sand.ai 官方契约（C1）。
 *
 * 用真的 HTTP 打本地假服务，因此验的是**线上字节**：请求体里到底有什么、没什么，
 * 上传的大整数 id 有没有在序列化里丢精度，400 insufficient_credits 有没有被识别成
 * pending_quota（而不是可重试失败），取消信号能不能真的把轮询打断。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Magi2Provider } from '../lib/core/providers/magi2.js'
import { PENDING_QUOTA_CODE } from '../lib/core/providers/types.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function collect(body) {
  return new Promise((resolve) => {
    const chunks = []
    body.on('data', chunk => chunks.push(chunk))
    body.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** 起一个最小的假 Sand.ai；每个请求都进 rec.log，供断言。 */
async function startMock(handlers) {
  const rec = { log: [], assets: 0 }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const raw = await collect(req)
    const entry = { method: req.method, path: url.pathname, headers: req.headers, raw }
    rec.log.push(entry)
    if (url.pathname === '/v1/assets' && req.method === 'POST') {
      rec.assets += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      // 官方返回的是**裸整数** id —— 这里故意用 19 位，JSON.parse 会吃掉末位
      res.end('{"id": 1234567890123456789}')
      return
    }
    if (url.pathname === '/video.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' })
      res.end(Buffer.from('fake-mp4-bytes'))
      return
    }
    const handler = handlers[req.method + ' ' + url.pathname]
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"code":"not_found","message":"no route"}}')
      return
    }
    const result = await handler({ url, raw, body: raw.length === 0 ? undefined : JSON.parse(raw.toString('utf8')) })
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { rec, baseUrl: 'http://127.0.0.1:' + port, close: () => new Promise(resolve => server.close(resolve)) }
}

function makeProvider(baseUrl, dir) {
  return new Magi2Provider({
    baseUrl: () => baseUrl,
    apiKey: () => 'sand-test-key',
    defaultDuration: () => 8,
    assetCacheFile: () => join(dir, 'magi2-assets.json'),
  })
}

function makeCtx(overrides = {}) {
  const events = []
  return {
    events,
    ctx: {
      emit: event => events.push(event),
      cache: {
        fingerprint: () => 'fp',
        read: () => undefined,
        write: () => undefined,
        stats: () => ({ entries: 0, bytes: 0 }),
        artifacts: () => [],
      },
      dryRun: false,
      mock: false,
      log: () => {},
      save: (sub, name, bytes, meta) => ({
        id: meta?.id ?? name,
        kind: 'video',
        path: join(dirTmp, sub, name),
        url: '/api/dsh-video-forge/file/o/' + sub + '/' + name,
        fileKey: 'o/' + sub + '/' + name,
        bytes: bytes.length,
        meta: meta?.meta,
      }),
      tmpDir: dirTmp,
      config: {},
      ...overrides,
    },
  }
}

const dirTmp = mkdtempSync(join(tmpdir(), 'vf-magi2-'))

test('native：真发请求体不含 watermark/role，资产大整数 id 以十进制字符串回传，且二次复用不重复上传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-magi2-native-'))
  const refImage = join(dir, 'ref.png')
  writeFileSync(refImage, PNG_BYTES)

  const nativeBodies = []
  const mock = await startMock({
    'POST /v2/generations': ({ body }) => {
      nativeBodies.push(body)
      return { body: { id: 'task-1' } }
    },
    'GET /v2/generations/task-1': () => ({
      body: { status: 'succeeded', video_url: mock.baseUrl + '/video.mp4' },
    }),
  })

  try {
    const provider = makeProvider(mock.baseUrl, dir)
    const { ctx } = makeCtx()
    const request = {
      id: 'shot-1:video',
      provider: 'magi2',
      kind: 'video',
      params: { prompt: 'slow dolly across a steel monolith', durationSec: 6, ratio: '16:9', generateAudio: false, model: 'MAGI-2' },
    }

    // 参数里带本地图 → provider 先上传再换成 asset_id
    const result = await provider.run({ ...request, params: { ...request.params, referenceImages: [refImage] } }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.artifacts.length, 1)
    assert.equal(result.artifacts[0].meta.hasAudio, false, 'generateAudio=false 必须标记 hasAudio=false')
    assert.equal(result.artifacts[0].meta.mode, 'native')

    const [native] = nativeBodies
    assert.equal(Object.hasOwn(native, 'watermark'), false)
    assert.equal(Object.hasOwn(native, 'role'), false)
    assert.deepEqual(native['images'], [{ asset_id: '1234567890123456789', kind: 'image' }])
    assert.equal(native['duration'], 6)
    assert.equal(native['aspect_ratio'], '16:9')
    assert.equal(native['generate_audio'], false)
    for (const [key, value] of Object.entries(native)) {
      assert.notEqual(value, null, key + ' 不能是 null')
      assert.ok(!(Array.isArray(value) && value.length === 0), key + ' 不能是空数组')
    }
    // 上传用的是 multipart，且带 Bearer
    const upload = mock.rec.log.find(entry => entry.path === '/v1/assets')
    assert.match(String(upload.headers['content-type']), /multipart\/form-data/)
    assert.equal(upload.headers.authorization, 'Bearer sand-test-key')

    // 第二次（同内容）不再上传
    await provider.run({ ...request, params: { ...request.params, referenceImages: [refImage] } }, ctx)
    assert.equal(mock.rec.assets, 1, '同内容资产必须命中 SHA256 缓存，不重复上传')
  } finally {
    await mock.close()
  }
})

test('400 insufficient_credits → PendingQuota：抛 code=pending_quota，不重试，状态机记为 pending_quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-magi2-quota-'))
  const mock = await startMock({
    'POST /v2/generations': () => ({ status: 400, body: { error: { code: 'insufficient_credits', message: 'no credits' } } }),
  })
  try {
    const provider = makeProvider(mock.baseUrl, dir)
    const { ctx } = makeCtx()
    await assert.rejects(
      provider.run({ id: 't', provider: 'magi2', kind: 'video', params: { prompt: 'x' } }, ctx),
      error => {
        assert.equal(error.code, PENDING_QUOTA_CODE)
        assert.equal(error.retryable, false)
        assert.match(error.message, /官方配额未下发/)
        return true
      },
    )
    assert.equal(provider.keyState().state, 'pending_quota')
    assert.match(provider.keyState().detail, /配额/)
  } finally {
    await mock.close()
  }
})

test('首尾帧：自动走 Ark 兼容端点，content 带 role，且绝不带 watermark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-magi2-ark-'))
  const first = join(dir, 'first.png')
  const last = join(dir, 'last.png')
  writeFileSync(first, PNG_BYTES)
  writeFileSync(last, PNG_BYTES)

  const arkBodies = []
  const arkPath = '/compatible/ark/api/v3/contents/generations/tasks'
  const mock = await startMock({
    ['POST ' + arkPath]: ({ body }) => {
      arkBodies.push(body)
      return { body: { id: 'ark-task-1' } }
    },
    ['GET ' + arkPath + '/ark-task-1']: () => ({
      body: { status: 'succeeded', video_url: mock.baseUrl + '/video.mp4' },
    }),
  })
  try {
    const provider = makeProvider(mock.baseUrl, dir)
    const { ctx } = makeCtx()
    const result = await provider.run({
      id: 'shot-2:video',
      provider: 'magi2',
      kind: 'video',
      params: { prompt: 'morph between frames', firstFrame: first, lastFrame: last, duration: 5 },
    }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.artifacts[0].meta.mode, 'ark')

    const [ark] = arkBodies
    assert.equal(Object.hasOwn(ark, 'watermark'), false)
    const content = ark['content']
    assert.equal(content[0].type, 'text')
    assert.match(content[0].text, /--duration 5/)
    assert.equal(content[1].role, 'first_frame')
    assert.equal(content[2].role, 'last_frame')
    // 本地首尾帧被内联成 data: URL（官方端点只吃公网 URL 或 data:）
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/)
    // Native 端点一次都没被打
    assert.equal(mock.rec.log.filter(entry => entry.path === '/v2/generations').length, 0)
  } finally {
    await mock.close()
  }
})

test('取消：AbortSignal 能真的把轮询打断（不等到 400s 超时）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-magi2-abort-'))
  const mock = await startMock({
    'POST /v2/generations': () => ({ body: { id: 'task-long' } }),
    'GET /v2/generations/task-long': () => ({ body: { status: 'running' } }),
  })
  try {
    const provider = makeProvider(mock.baseUrl, dir)
    const controller = new AbortController()
    const { ctx } = makeCtx({ signal: controller.signal })
    const started = Date.now()
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(
      provider.run({ id: 't', provider: 'magi2', kind: 'video', params: { prompt: 'x', timeoutMs: 400_000 } }, ctx),
      error => /已取消|aborted/.test(String(error.message) + String(error.code ?? '')),
    )
    assert.ok(Date.now() - started < 5_000, '取消必须在 5s 内生效')
  } finally {
    await mock.close()
  }
})
