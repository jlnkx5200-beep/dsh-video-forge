#!/usr/bin/env node
/**
 * 渲染一帧静帧（验证渲染链路 / 出封面图用）。
 *
 * 为什么需要这层包装：
 *  1. Remotion 的 Root 会被 webpack 打进浏览器包，**不能**在里面 import `node:fs`（会 UnhandledSchemeError），
 *     所以 Node 侧不读 plan 文件 —— 由这里读出来，整份内联进 `--props`。
 *  2. MSYS/Git-Bash 下 `npx remotion` 会被 `C:\Program Files\nodejs` 里的空格打断，
 *     因此直接 `node <cli.js>` 且用 spawnSync 数组参数（不经过 shell），引号/空格全部安全。
 *
 * 用法：
 *   node scripts/still.mjs [plan路径] [帧号] [输出png] [--composition=VideoForge] [--chrome=路径]
 *   node scripts/still.mjs                                  # 默认渲内置 Demo-Spatial 第 45 帧
 *   node scripts/still.mjs public/forge/plan-xxx/plan.json 45 out/cover.png
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { spawnEnv } from './_tmp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..') // remotion/

const args = process.argv.slice(2)
const flags = new Map(
  args
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...rest] = a.slice(2).split('=')
      return [k, rest.join('=')]
    }),
)
const positional = args.filter(a => !a.startsWith('--'))

// 带 --composition 时，第一个位置参数若不像 plan 文件就当成帧号
const first = positional[0]
const looksLikePlan = first !== undefined && (/\.json$/i.test(first) || existsSync(first))
const planArg = looksLikePlan ? first : undefined
const framePos = looksLikePlan ? positional[1] : first
const frame = Number(flags.get('frame') ?? framePos ?? 45)
const outArg = flags.get('out') ?? (looksLikePlan ? positional[2] : positional[1])
const composition = flags.get('composition') ?? (planArg ? 'VideoForge' : 'Demo-Spatial')

if (!Number.isFinite(frame) || frame < 0) {
  console.error('帧号必须是 >= 0 的整数，收到：' + positional[1])
  process.exit(2)
}

/** 把 plan.json 读成 props；读不到就返回空 props（Composition 自带 Demo 兜底）。 */
function propsFromPlan(planPath) {
  if (!planPath) return {}
  const abs = isAbsolute(planPath) ? planPath : existsSync(join(process.cwd(), planPath))
    ? join(process.cwd(), planPath)
    : join(root, planPath)
  if (!existsSync(abs)) {
    console.warn('[still] plan 不存在，改用内置 demo：' + abs)
    return {}
  }
  const plan = JSON.parse(readFileSync(abs, 'utf8'))
  console.log('[still] plan 已内联：' + abs + '（' + plan.shots?.length + ' 镜头 / ' + plan.durationInFrames + ' 帧）')
  return { plan }
}

/** 优先本机 Chrome；Remotion 自带 headless shell 在受限网络下经常下载不来。 */
function chromePath() {
  const explicit = flags.get('chrome') ?? process.env.REMOTION_BROWSER_EXECUTABLE
  if (explicit) return explicit
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]
  return candidates.find(p => existsSync(p)) ?? null
}

const out = outArg ?? join('out', 'still-' + composition + '-' + frame + '.png')
const extraArg = process.argv.slice(2).find(a => a.startsWith('--props-extra='))
const extra = extraArg ? JSON.parse(extraArg.slice('--props-extra='.length)) : {}
const props = { ...propsFromPlan(planArg), ...extra }
const chrome = chromePath()

const cliArgs = [
  join(root, 'node_modules/@remotion/cli/remotion-cli.js'),
  'still',
  'src/index.ts',
  composition,
  out,
  '--frame=' + frame,
  '--props=' + JSON.stringify(props),
]
if (chrome) cliArgs.push('--browser-executable=' + chrome)

console.log('[still] ' + composition + ' frame=' + frame + ' → ' + out + (chrome ? '\n[still] chrome: ' + chrome : ''))
const started = Date.now()
const res = spawnSync(process.execPath, cliArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: spawnEnv(),
})
if (res.error) {
  console.error('[still] 启动失败：' + res.error.message)
  process.exit(1)
}
if (res.status !== 0) {
  console.error('[still] 渲染失败，退出码 ' + res.status)
  process.exit(res.status ?? 1)
}
const abs = isAbsolute(out) ? out : join(root, out)
console.log('[still] 完成，用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's → ' + abs)
if (!existsSync(abs)) {
  console.error('[still] 退出码 0 但没有产物，检查上面的日志')
  process.exit(1)
}
