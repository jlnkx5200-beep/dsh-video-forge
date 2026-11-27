#!/usr/bin/env node
/**
 * 渲染成视频（mp4）。
 *
 * 和 still.mjs 同一套理由：Root 会被 webpack 打进浏览器包，不能 import `node:fs`，
 * 所以 plan 由这个脚本读出来、整份内联进 `--props`；并且直接 `node <cli.js>` + spawnSync
 * 数组参数，避开 MSYS 下 `npx` 被 `C:\Program Files\nodejs` 空格打断的问题。
 *
 * 用法：
 *   node scripts/render.mjs [plan路径] [输出mp4] [--composition=VideoForge] [--frames=0-119]
 *                           [--crf=18] [--concurrency=1] [--chrome=路径] [--muted]
 *   node scripts/render.mjs --composition=Demo-VideoClip out/demo.mp4
 *
 * 音轨：**默认保留**（片源有音轨就带进成片，MAGI-2 / H3 原生音画同步要用）。`--muted` 显式静音。
 * 子进程的 TEMP/TMP/TMPDIR 一律指向 `~/.dsh/video-forge/tmp`（见 `_tmp.mjs` 里的根因说明）。
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

const first = positional[0]
const looksLikePlan = first !== undefined && (/\.json$/i.test(first) || existsSync(first))
const planArg = looksLikePlan ? first : undefined
const composition = flags.get('composition') ?? (planArg ? 'VideoForge' : 'Demo-VideoClip')
const outArg = flags.get('out') ?? (looksLikePlan ? positional[1] : positional[0])

/** 把 plan.json 读成 props；读不到就返回空 props（Composition 自带 Demo 兜底）。 */
function propsFromPlan(planPath) {
  if (!planPath) return {}
  const abs = isAbsolute(planPath)
    ? planPath
    : existsSync(join(process.cwd(), planPath))
      ? join(process.cwd(), planPath)
      : join(root, planPath)
  if (!existsSync(abs)) {
    console.warn('[render] plan 不存在，改用内置 demo：' + abs)
    return {}
  }
  const plan = JSON.parse(readFileSync(abs, 'utf8'))
  console.log('[render] plan 已内联：' + abs + '（' + plan.shots?.length + ' 镜头 / ' + plan.durationInFrames + ' 帧）')
  return { plan }
}

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

const out = outArg ?? join('out', composition + '.mp4')
const props = propsFromPlan(planArg)
const chrome = chromePath()
const crf = flags.get('crf') ?? '18'
const concurrency = flags.get('concurrency') ?? '1'

const cliArgs = [
  join(root, 'node_modules/@remotion/cli/remotion-cli.js'),
  'render',
  'src/index.ts',
  composition,
  out,
  '--codec=h264',
  '--crf=' + crf,
  '--concurrency=' + concurrency,
  '--props=' + JSON.stringify(props),
]
// 音轨默认保留：Remotion 会对有音的 composition 做混流，MAGI-2 / H3 的原生音画同步依赖这条链路。
// 只有显式 `--muted` 才静音（占位片/无音轨素材想省一次混流时用）。
if (flags.has('muted') && flags.get('muted') !== '0') cliArgs.push('--muted')

const frames = flags.get('frames')
if (frames !== undefined) cliArgs.push('--frames=' + frames)
if (chrome) cliArgs.push('--browser-executable=' + chrome)

console.log('[render] ' + composition + ' → ' + out + (chrome ? '\n[render] chrome: ' + chrome : ''))
const started = Date.now()
const res = spawnSync(process.execPath, cliArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: spawnEnv(),
})
if (res.error) {
  console.error('[render] 启动失败：' + res.error.message)
  process.exit(1)
}
if (res.status !== 0) {
  console.error('[render] 渲染失败，退出码 ' + res.status)
  process.exit(res.status ?? 1)
}
const abs = isAbsolute(out) ? out : join(root, out)
console.log('[render] 完成，用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's → ' + abs)
if (!existsSync(abs)) {
  console.error('[render] 退出码 0 但没有产物，检查上面的日志')
  process.exit(1)
}
