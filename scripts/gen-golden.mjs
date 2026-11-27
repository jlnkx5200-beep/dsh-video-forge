#!/usr/bin/env node
/**
 * 生成像素回归基线（P1-6 的前半步）。
 *
 * 为什么需要它：契约门禁（check-plan）只验结构，画面回归全靠人眼 —— 这让"改一行 GLSL
 * 顺手把色彩管线弄脏"这类事故没人拦得住。基线把"看着没变"变成"像素没变"。
 *
 * 为什么基线要小：committed PNG 会进 git。所以刻意用 960x540 / still-3d / mock，
 * 只求覆盖「色彩管线 + 图层尺寸 + 确定性」这三件最容易回归的事。
 *
 * 用法：node scripts/gen-golden.mjs        # 重新生成 golden 计划与基线帧（会覆盖）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ForgeRuntime } from '../lib/core/runtime.js'
import { ensureDirs } from '../lib/core/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const remotion = join(root, 'remotion')
const GOLDEN_ID = 'golden-baseline-v1'
const FRAMES = [0, 24]
const MAX_DIFF = 2

const home = process.env.VF_HOME ?? mkdtempSync(join(tmpdir(), 'vf-golden-'))
const paths = ensureDirs(home)
const ffmpeg = process.env.FFMPEG_PATH ?? join(root, '..', 'tools', 'ffmpeg', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg')

const runtime = new ForgeRuntime({
  config: () => ({
    arkBaseUrl: 'http://127.0.0.1:1', arkApiKey: '', defaultSeedreamModel: '5.0-flash',
    minimaxBaseUrl: 'http://127.0.0.1:1', minimaxApiKey: '', defaultMinimaxModel: 'MiniMax-H3',
    minimaxResolution: '768P', sandBaseUrl: 'https://api.sand.ai', sandApiKey: '', defaultMagi2Duration: 8,
    comfyBaseUrl: 'http://127.0.0.1:8188', workflowDir: join(root, 'workflows'), outputDir: paths.outDir,
    bridgeToken: '', ffmpegPath: ffmpeg,
  }),
  paths: () => paths,
  pluginRoot: root,
  eventBuffer: 200,
})

const storyboard = {
  id: GOLDEN_ID,
  title: 'Golden baseline（像素回归）',
  width: 960,
  height: 540,
  fps: 24,
  preset: 'cinematic-realism',
  style: { tags: ['cinematic'], palette: ['#0b0f19', '#1b2740', '#e8ecf5'] },
  shots: [
    { id: 'g1', shot: '全景', durationSec: 2, move: 'dolly-in', prompt: 'a lone monolith under cold rain, wide establishing shot' },
    { id: 'g2', shot: '中景', durationSec: 2, move: 'orbit', transition: 'crossfade', prompt: 'medium shot, the monolith turning slowly in the mist' },
  ],
}

const job = await runtime.produce(storyboard, {
  defaultStrategy: 'still-3d',
  qualityMode: 'production',
  depthWorkflow: 'dsh-depth-v2.api.json',
  enablePlate: false,
  preset: 'cinematic-realism',
  mock: true,
  useCache: true,
  writePlan: true,
  concurrency: 3,
})
if (job.status !== 'done') {
  console.error('[gen-golden] 产出失败：', job.status, job.error)
  process.exit(1)
}

const sourceDir = join(remotion, 'public', 'forge', job.planId)
const targetDir = join(remotion, 'public', 'golden', GOLDEN_ID)
mkdirSync(targetDir, { recursive: true })

const prefix = 'forge/' + job.planId + '/'
const plan = JSON.parse(readFileSync(join(sourceDir, 'plan.json'), 'utf8'))
const rewrite = value => (typeof value === 'string' && value.startsWith(prefix) ? 'golden/' + GOLDEN_ID + '/' + value.slice(prefix.length) : value)

for (const shot of plan.shots) {
  for (const key of Object.keys(shot.assets ?? {})) shot.assets[key] = rewrite(shot.assets[key])
  if (shot.layer !== undefined) {
    shot.layer.src = rewrite(shot.layer.src)
    if (shot.layer.depthSrc !== undefined) shot.layer.depthSrc = rewrite(shot.layer.depthSrc)
    if (shot.layer.matteSrc !== undefined) shot.layer.matteSrc = rewrite(shot.layer.matteSrc)
  }
  if (shot.video !== undefined) shot.video.src = rewrite(shot.video.src)
}
plan.id = GOLDEN_ID
plan.title = storyboard.title
writeFileSync(join(targetDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')

let copied = 0
for (const name of readdirSync(sourceDir)) {
  if (!name.endsWith('.png')) continue
  copyFileSync(join(sourceDir, name), join(targetDir, name))
  copied += 1
}

const baselineDir = join(root, 'fixtures', 'golden')
mkdirSync(baselineDir, { recursive: true })
const entries = []
for (const frame of FRAMES) {
  const outPng = join(baselineDir, GOLDEN_ID + '-f' + String(frame).padStart(3, '0') + '.png')
  const still = spawnSync(process.execPath, ['scripts/still.mjs', 'public/golden/' + GOLDEN_ID + '/plan.json', String(frame), outPng], { cwd: remotion, encoding: 'utf8' })
  if (still.status !== 0 || !existsSync(outPng)) {
    console.error('[gen-golden] 渲帧失败 frame=' + frame, still.stderr?.slice(-400))
    process.exit(1)
  }
  entries.push({ frame, png: GOLDEN_ID + '-f' + String(frame).padStart(3, '0') + '.png', maxDiff: MAX_DIFF })
}

const manifest = {
  $comment: '像素回归基线：由 node scripts/gen-golden.mjs 生成；node scripts/check-frames.mjs 校验。maxDiff 为单通道 0–255 的容差。',
  version: 1,
  plan: 'golden/' + GOLDEN_ID + '/plan.json',
  planId: GOLDEN_ID,
  size: { width: plan.width, height: plan.height, fps: plan.fps },
  frames: entries,
}
writeFileSync(join(baselineDir, 'baselines.json'), JSON.stringify(manifest, null, 2) + '\n')

console.log('[gen-golden] ok  plan=' + manifest.plan + ' assets=' + copied + ' frames=' + entries.length)
