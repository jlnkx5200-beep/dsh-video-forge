#!/usr/bin/env node
/**
 * 像素回归门禁（P1-6 的后半步）。
 *
 * 只做一件事：把 fixtures/golden 里的基线帧重渲一遍，逐像素比对。
 * 它拦的是「结构没坏、画面脏了」这类事故 —— check-quality 管规范，它管事实。
 *
 * 用法：
 *   node scripts/check-frames.mjs           # 比对，超阈值即失败
 *   node scripts/check-frames.mjs --update  # 确认是想要的改动后，重写基线
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const remotion = join(root, 'remotion')
const baselineDir = join(root, 'fixtures', 'golden')
const manifestPath = join(baselineDir, 'baselines.json')
const update = process.argv.includes('--update')

if (!existsSync(manifestPath)) {
  console.error('[check-frames] 缺少基线清单：' + manifestPath + '（先跑 node scripts/gen-golden.mjs）')
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const frames = Array.isArray(manifest.frames) ? manifest.frames : []
if (frames.length === 0) {
  console.error('[check-frames] 基线清单里没有帧')
  process.exit(2)
}

const workDir = join(remotion, 'out', 'frames-check')
mkdirSync(workDir, { recursive: true })

let failed = 0
for (const entry of frames) {
  const baselinePath = join(baselineDir, entry.png)
  const actualPath = join(workDir, 'f' + String(entry.frame).padStart(3, '0') + '.png')
  const tolerance = Number(entry.maxDiff ?? 2)

  const still = spawnSync(process.execPath, ['scripts/still.mjs', 'public/' + manifest.plan, String(entry.frame), actualPath], { cwd: remotion, encoding: 'utf8' })
  if (still.status !== 0 || !existsSync(actualPath)) {
    console.error('[check-frames] frame ' + entry.frame + ' 渲帧失败')
    console.error((still.stderr ?? '').slice(-500))
    failed += 1
    continue
  }

  if (!existsSync(baselinePath)) {
    if (update) {
      copyFileSync(actualPath, baselinePath)
      console.log('[check-frames] frame ' + entry.frame + ' 基线缺失，已写入（--update）')
      continue
    }
    console.error('[check-frames] frame ' + entry.frame + ' 缺少基线图：' + entry.png)
    failed += 1
    continue
  }

  if (update) {
    copyFileSync(actualPath, baselinePath)
    console.log('[check-frames] frame ' + entry.frame + ' 基线已更新（--update）')
    continue
  }

  const diff = spawnSync(process.execPath, ['scripts/pngdiff.mjs', actualPath, baselinePath], { cwd: remotion, encoding: 'utf8' })
  const text = (diff.stdout ?? '') + (diff.stderr ?? '')
  const match = /maxDiff\s+([0-9]+(?:\.[0-9]+)?)/.exec(text)
  if (match === null) {
    console.error('[check-frames] frame ' + entry.frame + ' 无法解析比对结果：' + text.slice(0, 200))
    failed += 1
    continue
  }
  const maxDiff = Number(match[1])
  const ok = maxDiff <= tolerance
  console.log((ok ? '✓' : '✗') + ' frame ' + entry.frame + '  maxDiff=' + maxDiff + '（容差 ' + tolerance + '）')
  if (!ok) {
    failed += 1
    console.error('  基线：' + baselinePath)
    console.error('  实渲：' + actualPath + '  ← 确认这次变化是想要的，再跑 --update')
  }
}

if (update) {
  console.log('[check-frames] 基线已更新：' + frames.length + ' 帧')
  process.exit(0)
}

if (failed > 0) {
  console.error('[check-frames] 失败 ' + failed + '/' + frames.length + ' 帧：画面发生了非预期变化')
  process.exit(1)
}
console.log('[check-frames] 全部通过：' + frames.length + ' 帧像素一致')
