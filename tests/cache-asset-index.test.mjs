/**
 * 资产索引并入 ForgeCache（P1-4）：上传过的参考素材不该因为进程重启就重传一遍。
 * 这里验的是索引落在缓存目录、能读回、能按 TTL/存在性裁剪。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForgeCache } from '../lib/core/cache.js'

test('assetIndex：读写往返一致，未写过时返回空对象', () => {
  const root = mkdtempSync(join(tmpdir(), 'vf-cache-index-'))
  const cache = new ForgeCache(root)
  const index = cache.assetIndex('magi2')
  assert.deepEqual(index.read(), {})

  index.write({ '/a.png': { assetId: '1234567890123456789', at: 1 } })
  assert.equal(existsSync(join(root, '_assets', 'magi2.json')), true)
  const reopened = cache.assetIndex('magi2').read()
  assert.equal(reopened['/a.png'].assetId, '1234567890123456789')

  // 同名索引第二次构造仍读同一份文件（跨进程可用），不同名互不污染
  assert.deepEqual(cache.assetIndex('other').read(), {})
})

test('assetIndex.prune：只留下 exists 判定为真的条目，并报告计数', () => {
  const root = mkdtempSync(join(tmpdir(), 'vf-cache-prune-'))
  const cache = new ForgeCache(root)
  const index = cache.assetIndex('magi2')
  index.write({
    keep: { assetId: '1', at: 1 },
    drop: { assetId: '2', at: 2 },
  })
  const before = cache.assetIndex('magi2')
  const result = before.prune(key => key === 'keep')
  assert.deepEqual(result, { removed: 1, kept: 1 })
  assert.deepEqual(Object.keys(cache.assetIndex('magi2').read()), ['keep'])
})
