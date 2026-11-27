#!/usr/bin/env node
/**
 * 视觉自检用的 mock 端到端产出（docs/visual-quality-standard.md §4 第 1 步）。
 *
 * 为什么单独写这个脚本：视觉自检必须走**真实的生产链路**（compiler → scheduler →
 * providers → RenderPlan → relocateAssets），只是把 Provider 换成 mock。
 * 直接手写 plan.json 等于绕过了被改动的代码，测不到东西。
 *
 * 用法：
 *   node scripts/qa-mock.mjs                 # 默认 4 镜、1080p、production 门禁
 *   node scripts/qa-mock.mjs --strategy=magi2-direct
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ForgeRuntime } from '../lib/core/runtime.js'
import { ensureDirs } from '../lib/core/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = new Map(process.argv.slice(2).filter(a => a.startsWith('--')).map((a) => {
  const [k, ...rest] = a.slice(2).split('=')
  return [k, rest.join('=')]
}))

const strategy = args.get('strategy') ?? 'seedream-static'
const home = process.env.VF_HOME ?? mkdtempSync(join(tmpdir(), 'vf-qa-'))
const paths = ensureDirs(home)
const ffmpeg = process.env.FFMPEG_PATH ?? join(root, '..', 'tools', 'ffmpeg', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg')

const runtime = new ForgeRuntime({
  config: () => ({
    arkBaseUrl: 'http://127.0.0.1:1',
    arkApiKey: '',
    defaultSeedreamModel: '5.0-flash',
    minimaxBaseUrl: 'http://127.0.0.1:1',
    minimaxApiKey: '',
    defaultMinimaxModel: 'MiniMax-H3',
    minimaxResolution: '768P',
    sandBaseUrl: 'https://api.sand.ai',
    sandApiKey: '',
    defaultMagi2Duration: 8,
    comfyBaseUrl: 'http://127.0.0.1:8188',
    workflowDir: join(root, 'workflows'),
    outputDir: paths.outDir,
    bridgeToken: '',
    ffmpegPath: ffmpeg,
  }),
  paths: () => paths,
  pluginRoot: root,
  eventBuffer: 400,
})

const storyboard = {
  id: 'qa-magi2-client-' + Date.now().toString(36),
  title: 'QA · MAGI-2 / 客户端改造回归',
  width: 1920,
  height: 1080,
  fps: 30,
  preset: 'cinematic-realism',
  style: { tags: ['cinematic', 'volumetric light'], palette: ['#0b0f19', '#1b2740', '#e8ecf5'] },
  shots: [
    { id: 's1', shot: '全景建立', durationSec: 4, move: 'dolly-in', transition: 'crossfade', prompt: 'a lone monolith under cold rain, wide establishing shot, volumetric fog' },
    { id: 's2', shot: '特写', durationSec: 3, move: 'handheld', transition: 'crossfade', prompt: 'close-up of rain beading on brushed steel, shallow depth of field' },
    { id: 's3', shot: '中景', durationSec: 3, move: 'orbit', transition: 'crossfade', prompt: 'medium shot, the monolith turning slowly in the mist' },
    { id: 's4', shot: '收尾', durationSec: 3, move: 'dolly-out', transition: 'crossfade', prompt: 'pull back, the horizon dissolving into pale light' },
  ],
}

const job = await runtime.produce(storyboard, {
  defaultStrategy: strategy,
  qualityMode: 'production',
  // mock 模式下 ComfyUI 也被 mock 顶替：这里配真工作流名，只为让 depth/matte/plate
  // 三个任务真的被编译出来（否则视差只能按亮度近似，看不出版式问题）。
  depthWorkflow: 'dsh-depth-v2.api.json',
  matteWorkflow: 'dsh-matte-v2.api.json',
  plateWorkflow: 'dsh-plate.api.json',
  enablePlate: true,
  preset: 'cinematic-realism',
  mock: true,
  dryRun: false,
  useCache: true,
  writePlan: true,
  concurrency: 3,
})

console.log(JSON.stringify({
  ok: job.status === 'done',
  status: job.status,
  planId: job.planId,
  planJsonPath: job.planJsonPath,
  planPath: job.planPath,
  results: job.results.map(result => ({ id: result.id, provider: result.provider, ok: result.ok, artifacts: result.artifacts.length, error: result.error })),
  issues: job.issues,
  error: job.error,
}, null, 2))

if (job.status !== 'done') process.exitCode = 1
