/**
 * MAGI-2 请求体净化的契约测试（C1 核心项）。
 *
 * 这里守的是官方三条硬性序列化规则，任何一条破了都是线上 400：
 *  1. 绝不出现 `watermark`（连 false 都不行）；
 *  2. Native 端点绝不出现 `role`（多参考按类型分组，多一个 role 就是未知字段）；
 *  3. 未使用的可选字段必须 omit，不能传 null/''/[]；
 *     并且 duration 必须是 4–30 的整数、resolution 只接受 "1080p"、ratio 只接受白名单。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAGI2_ASPECT_RATIOS, MAGI2_FORBIDDEN_FIELDS, MAGI2_LIMITS, MAGI2_RESOLUTIONS,
  assertNoForbiddenFields, buildArkBody, buildNativeBody, classifySandFailure,
  normalizeAssetId, parseJsonBigIntSafe, pickMagi2Mode, validateMagi2Spec,
} from '../lib/core/providers/magi2-payload.js'
import { PENDING_QUOTA_CODE } from '../lib/core/providers/types.js'

/** 深度遍历，收集所有 key 与所有值 —— 用来证明"没有 null、没有空数组"。 */
function walk(value, visit, path = '$') {
  visit(path, value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, path + '[' + index + ']'))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) walk(child, visit, path + '.' + key)
  }
}

test('native 请求体：最小参数下不含 watermark / role / null / 空数组', () => {
  const body = buildNativeBody({ prompt: '  a calm horizon  ' })
  const keys = []
  walk(body, (path, value) => {
    keys.push(path)
    assert.notEqual(value, null, path + ' 不能是 null（必须 omit）')
    assert.ok(!(Array.isArray(value) && value.length === 0), path + ' 不能是空数组')
    assert.notEqual(value, '', path + ' 不能是空字符串')
  })
  assert.equal(body['prompt'], 'a calm horizon')
  assert.equal(body['duration'], 8)
  assert.equal(Number.isInteger(body['duration']), true)
  assert.equal(Object.hasOwn(body, 'resolution'), false, '未指定分辨率时必须省略')
  assert.equal(Object.hasOwn(body, 'watermark'), false)
  assert.ok(!keys.some(path => path.endsWith('.role') || path === '$.role'), 'Native 不能出现 role')
  for (const field of MAGI2_FORBIDDEN_FIELDS) assert.equal(Object.hasOwn(body, field), false, field)
})

test('duration 被夹到 4–30 整数，resolution 只认 1080p，ratio 只认白名单', () => {
  assert.equal(buildNativeBody({ prompt: 'x', durationSec: 1 })['duration'], MAGI2_LIMITS.minDurationSec)
  assert.equal(buildNativeBody({ prompt: 'x', durationSec: 99 })['duration'], MAGI2_LIMITS.maxDurationSec)
  assert.equal(buildNativeBody({ prompt: 'x', durationSec: 6.4 })['duration'], 6)
  assert.equal(buildNativeBody({ prompt: 'x', resolution: '1080p' })['resolution'], '1080p')
  assert.throws(() => buildNativeBody({ prompt: 'x', resolution: '720p' }), /resolution 只支持/)
  assert.deepEqual(MAGI2_RESOLUTIONS, ['1080p'])
  assert.equal(buildNativeBody({ prompt: 'x', aspectRatio: '9:16' })['aspect_ratio'], '9:16')
  assert.throws(() => buildNativeBody({ prompt: 'x', aspectRatio: '5:4' }), /aspectRatio 只能是/)
  assert.equal(MAGI2_ASPECT_RATIOS.length, 6)
})

test('多参考按类型分组且不带 role；超上限在本地就报错', () => {
  const body = buildNativeBody({
    prompt: 'x',
    images: ['https://cdn.test/a.png', '123456789012345678'],
    videos: ['https://cdn.test/b.mp4'],
    audios: ['https://cdn.test/c.mp3'],
  })
  assert.equal(body['images'].length, 2)
  assert.equal(body['images'][1]['asset_id'], '123456789012345678')
  assert.equal(Object.hasOwn(body['images'][0], 'role'), false)
  assert.equal(Object.hasOwn(body['videos'][0], 'role'), false)
  assert.equal(Object.hasOwn(body['audios'][0], 'role'), false)
  assert.throws(() => validateMagi2Spec({ prompt: 'x', images: Array.from({ length: MAGI2_LIMITS.images + 1 }, (_, i) => 'id' + i) }, 'native'), /参考图最多/)
  assert.throws(() => validateMagi2Spec({ prompt: 'x', videoSeconds: MAGI2_LIMITS.videoSeconds + 1 }, 'native'), /参考视频总时长/)
  assert.throws(() => validateMagi2Spec({ prompt: 'x', audioSeconds: MAGI2_LIMITS.audioSeconds + 1 }, 'native'), /参考音频总时长/)
})

test('首尾帧：Ark 端点保留 role（官方 schema），Native 强制 native 会抛错', () => {
  const ark = buildArkBody({ prompt: 'x', firstFrame: 'https://cdn.test/f.png', lastFrame: 'https://cdn.test/l.png' })
  assert.equal(ark['content'][1]['role'], 'first_frame')
  assert.equal(ark['content'][2]['role'], 'last_frame')
  assert.equal(Object.hasOwn(ark, 'watermark'), false)
  assert.throws(() => assertNoForbiddenFields({ ...ark, watermark: false }, 'ark'), /watermark/)
  assert.throws(() => pickMagi2Mode({ firstFrame: 'a.png' }, 'native'), /首尾帧只能走 Ark/)
  assert.throws(() => validateMagi2Spec({ prompt: 'x', firstFrame: 'a.png', images: ['b.png'] }, 'ark'), /互斥/)
  assert.throws(() => validateMagi2Spec({ prompt: 'x', lastFrame: 'b.png' }, 'ark'), /lastFrame 必须与 firstFrame 同时提供/)
})

test('assertNoForbiddenFields 在 native 下能抓出任意深度的 role', () => {
  assert.throws(() => assertNoForbiddenFields({ prompt: 'x', images: [{ url: 'u', role: 'reference_image' }] }, 'native'), /role 字段/)
  assert.doesNotThrow(() => assertNoForbiddenFields({ prompt: 'x', images: [{ url: 'u' }] }, 'native'))
})

test('资产 id 大整数安全：19 位裸整数不许被浮点吃掉末位', () => {
  const big = '1234567890123456789'
  assert.equal(normalizeAssetId(big), big)
  assert.equal(normalizeAssetId(42), '42')
  assert.equal(normalizeAssetId({ id: big }), big)
  assert.equal(normalizeAssetId(42n), '42')
  assert.throws(() => normalizeAssetId(1234567890123456789), /超出安全整数范围/)
  assert.throws(() => normalizeAssetId(''), /资产 id 为空/)
  const parsed = parseJsonBigIntSafe('{"id": ' + big + ', "task_id": 9007199254740993, "other": 12345678901234567890}')
  assert.equal(parsed['id'], big)
  assert.equal(parsed['task_id'], '9007199254740993')
  // 非 id 字段不做改动（避免误伤正常数字）
  assert.equal(parsed['other'], 12345678901234567890)
})

test('官方错误语义化：401 → invalid_key，400 insufficient_credits → pending_quota', () => {
  const invalid = classifySandFailure(401, { error: { code: 'invalid_api_key', message: 'bad key' } })
  assert.equal(invalid.code, 'invalid_key')
  assert.equal(invalid.retryable, false)

  const quota = classifySandFailure(400, { error: { code: 'insufficient_credits', message: 'no credits' } }, { prompt: 'x' })
  assert.equal(quota.code, PENDING_QUOTA_CODE)
  assert.equal(quota.retryable, false, '待配额绝不能当成可重试错误去烧配额')
  assert.match(quota.message, /官方配额未下发/)
  assert.match(quota.message, /等待官方配额下发后无需改代码/)
  assert.equal(quota.detail.requestSnapshot.prompt, 'x', 'pending_quota 必须带着 requestSnapshot 才能重放')

  assert.equal(classifySandFailure(429, { message: 'slow down' }).retryable, true)
  assert.equal(classifySandFailure(500, { message: 'boom' }).retryable, true)
})
