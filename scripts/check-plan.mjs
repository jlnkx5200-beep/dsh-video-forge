#!/usr/bin/env node
/**
 * RenderPlan 契约检查（零依赖）。
 *
 * 为什么要有它：RenderPlan 是 host（TS）↔ Remotion（TS 镜像）↔ 人工编辑 三方共用的
 * 唯一跨进程契约。任何一方悄悄改了形状，渲染出来就是黑屏或错机位，而不是报错。
 * 这个脚本独立于两端实现（不复用任何 import），专门盯"契约本身是否合法"：
 *
 *   node scripts/check-plan.mjs                       # 检查内置夹具
 *   node scripts/check-plan.mjs path/to/plan.json     # 检查任意 plan
 *   node scripts/check-plan.mjs --all                 # 检查 public/forge 下所有 plan
 *
 * 退出码：0 无 error（可有 warn）；1 存在 error；2 用法/读取错误。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const STRATEGIES = [
  'seedream-static', 'still-3d', 'minimax-direct', 'minimax-2k-repaint', 'comfy-pipeline',
  'magi2-direct', 'magi2-i2v',
]
const BLENDS = ['normal', 'additive', 'multiply', 'luakay']
const TRANSITIONS = ['crossfade', 'radial-blur', 'luma-wipe', 'noise-dissolve', 'push']
const PRESETS_HINT = [
  // 六套 StyleSpec 预设（remotion/src/presets/index.ts 的 PRESETS 键）
  'cinematic-realism',
  'editorial-minimal',
  'anime-atmospheric',
  'cyber-neon',
  'oriental-ink',
  'video-first',
  // legacy 预设仍可选中
  'spatial',
  'parallax',
]

const issues = []
const err = (path, message) => issues.push({ level: 'error', path, message })
const warn = (path, message) => issues.push({ level: 'warn', path, message })

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isStr = (v) => typeof v === 'string' && v.trim() !== ''
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)

function checkKeyframe(path, frame) {
  if (frame === undefined) return
  if (Array.isArray(frame)) {
    err(path, '关键帧不能是裸数组 [x,y,z]，必须是 {position:[x,y,z], lookAt:[x,y,z]}（parse.ts 只会读 position/lookAt 字段）')
    return
  }
  if (typeof frame !== 'object' || frame === null) {
    err(path, `关键帧必须是对象，收到 ${typeof frame}`)
    return
  }
  if (!isVec3(frame.position)) err(`${path}.position`, 'position 必须是三个有限数字')
  if (!isVec3(frame.lookAt)) err(`${path}.lookAt`, 'lookAt 必须是三个有限数字')
}

function checkTransition(path, t) {
  if (t === undefined || t === null) return
  if (typeof t !== 'object') return err(path, '转场必须是对象')
  if (!TRANSITIONS.includes(t.type)) {
    err(`${path}.type`, `未知转场 ${JSON.stringify(t.type)}，可用：${TRANSITIONS.join(' / ')}`)
  }
  if (t.durationInFrames !== undefined && (!isNum(t.durationInFrames) || t.durationInFrames < 0)) {
    err(`${path}.durationInFrames`, '转场时长必须是非负数字')
  }
}

function checkShot(shot, index) {
  const at = shot && typeof shot.id === 'string' ? shot.id : `shots[${index}]`
  const p = `shots[${index}]`
  if (!shot || typeof shot !== 'object') return err(p, '镜头必须是对象')
  if (!isStr(shot.id)) err(`${p}.id`, '镜头 id 不能为空')
  if (!isNum(shot.from) || shot.from < 0) err(`${p}.from`, 'from 必须是非负帧号')
  if (!isNum(shot.durationInFrames) || shot.durationInFrames <= 0) err(`${p}.durationInFrames`, '时长必须是正帧数')
  if (!STRATEGIES.includes(shot.strategy)) {
    err(`${p}.strategy`, `未知策略 ${JSON.stringify(shot.strategy)}，可用：${STRATEGIES.join(' / ')}`)
  }

  const camera = shot.camera
  if (camera !== undefined && camera !== null) {
    if (!isStr(camera.move)) warn(`${p}.camera.move`, '缺少运镜名，会回落 static（画面不动）')
    checkKeyframe(`${p}.camera.from`, camera.from)
    checkKeyframe(`${p}.camera.to`, camera.to)
    if (camera.fov !== undefined && (!isNum(camera.fov) || camera.fov <= 0 || camera.fov >= 180)) {
      err(`${p}.camera.fov`, 'fov 必须在 (0,180) 之间')
    }
  }

  const layer = shot.layer
  if (layer !== undefined && layer !== null) {
    if (!isStr(layer.src)) err(`${p}.layer.src`, '层贴图路径不能为空（空串会被 parse.ts 丢弃）')
    for (const key of ['depthSrc', 'matteSrc']) {
      if (layer[key] !== undefined && !isStr(layer[key])) err(`${p}.layer.${key}`, '路径必须是非空字符串')
    }
  }

  const video = shot.video
  if (video !== undefined && video !== null) {
    if (!isStr(video.src)) err(`${p}.video.src`, '视频路径不能为空')
    if (video.blend !== undefined && !BLENDS.includes(video.blend)) {
      err(`${p}.video.blend`, `未知混合模式 ${JSON.stringify(video.blend)}，可用：${BLENDS.join(' / ')}`)
    }
  }

  if (!layer && !video) {
    err(p, `${at}：既没有 layer 也没有 video，渲染器无法出画`)
  }
  if (shot.postFX !== undefined && !Array.isArray(shot.postFX)) err(`${p}.postFX`, 'postFX 必须是字符串数组')

  checkTransition(`${p}.transitionIn`, shot.transitionIn)
  checkTransition(`${p}.transitionOut`, shot.transitionOut)

  if (shot.assets && typeof shot.assets === 'object') {
    for (const [key, value] of Object.entries(shot.assets)) {
      if (value !== undefined && value !== null && !isStr(value)) err(`${p}.assets.${key}`, '资产路径必须是非空字符串')
    }
  }
}

export function checkPlan(plan) {
  const before = issues.length
  const slice = () => issues.slice(before)

  if (!plan || typeof plan !== 'object') {
    err('$', 'plan 必须是 JSON 对象')
    return slice()
  }
  if (plan.version !== 1) err('$.version', `version 必须是 1，收到 ${JSON.stringify(plan.version)}`)
  if (!isStr(plan.id)) err('$.id', 'id 不能为空')
  if (!isNum(plan.width) || plan.width <= 0) err('$.width', 'width 必须是正数')
  if (!isNum(plan.height) || plan.height <= 0) err('$.height', 'height 必须是正数')
  if (!isNum(plan.fps) || plan.fps <= 0) err('$.fps', 'fps 必须是正数')
  if (!isNum(plan.durationInFrames) || plan.durationInFrames <= 0) err('$.durationInFrames', '总帧数必须是正数')
  if (!isStr(plan.preset)) warn('$.preset', '缺少预设名，Remotion 侧会回落 spatial')
  else if (!PRESETS_HINT.includes(plan.preset)) {
    warn('$.preset', `非内置预设 ${JSON.stringify(plan.preset)}：内置 ${PRESETS_HINT.join(' / ')}；其它名字需要先 registerPreset()`)
  }

  const shots = plan.shots
  if (!Array.isArray(shots) || shots.length === 0) {
    err('$.shots', '至少需要一个镜头')
    return slice()
  }

  let cursor = 0
  shots.forEach((shot, i) => {
    checkShot(shot, i)
    if (shot && isNum(shot.from) && shot.from !== cursor) {
      warn(`shots[${i}].from`, `时间轴不连续：期望 ${cursor}，实际 ${shot.from}（parse.ts 会自动重排为 ${cursor}）`)
    }
    if (shot && isNum(shot.durationInFrames)) cursor = (isNum(shot.from) ? shot.from : cursor) + shot.durationInFrames
  })

  if (isNum(plan.durationInFrames) && cursor !== plan.durationInFrames) {
    warn('$.durationInFrames', `镜头累计 ${cursor} 帧 ≠ 总时长 ${plan.durationInFrames} 帧（Remotion Composition 以总时长为准，尾部会静止）`)
  }

  return slice()
}

function report(label, list) {
  const errors = list.filter((i) => i.level === 'error')
  const warns = list.filter((i) => i.level === 'warn')
  if (errors.length === 0 && warns.length === 0) {
    console.log(`✓ ${label}：契约检查通过`)
    return 0
  }
  for (const item of warns) console.warn(`  ⚠ ${item.path}  ${item.message}`)
  for (const item of errors) console.error(`  ✗ ${item.path}  ${item.message}`)
  const head = errors.length === 0 ? `✓ ${label}：通过（${warns.length} 条提醒）` : `✗ ${label}：${errors.length} 个错误`
  ;(errors.length === 0 ? console.log : console.error)(head)
  return errors.length === 0 ? 0 : 1
}

function loadOne(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    console.error(`✗ 读取失败 ${file}: ${e.message}`)
    return 2
  }
  let plan
  try {
    plan = JSON.parse(raw)
  } catch (e) {
    console.error(`✗ JSON 解析失败 ${file}: ${e.message}`)
    return 2
  }
  return report(file, checkPlan(plan))
}

function main(argv) {
  if (argv.includes('--all')) {
    const dir = join(ROOT, 'remotion', 'public', 'forge')
    if (!existsSync(dir)) {
      console.log(`· ${dir} 还不存在（尚未跑过 produce），跳过`)
      return 0
    }
    let worst = 0
    for (const name of readdirSync(dir)) {
      const planFile = join(dir, name, 'plan.json')
      if (!existsSync(planFile)) continue
      worst = Math.max(worst, loadOne(planFile))
    }
    return worst
  }

  const target = argv.find((a) => !a.startsWith('-'))
  const file = target ? resolve(process.cwd(), target) : join(ROOT, 'fixtures', 'render-plan.example.json')
  if (!existsSync(file) || !statSync(file).isFile()) {
    console.error(`✗ 找不到 plan 文件：${file}`)
    return 2
  }
  return loadOne(file)
}

process.exitCode = main(process.argv.slice(2))
