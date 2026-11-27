#!/usr/bin/env node
/**
 * 画质静态门禁（docs/visual-quality-standard.md 第 3、4 节的机器可验证部分）
 *
 *   node scripts/check-quality.mjs                 # 全量检查
 *   node scripts/check-quality.mjs --all-plans     # 额外逐个校验 public/forge 下的 plan
 *   node scripts/check-quality.mjs --plan <file>   # 只校验指定 plan
 *
 * 退出码：0 = 通过；1 = 有 error；2 = 只有 warn（--strict 时也视为失败）
 *
 * 这里只做"能静态判定"的红线；视觉观感必须用 still/render 出图后人工打分（docs/visual-quality-standard.md 第 4 节）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REMOTION = join(ROOT, 'remotion')
const issues = []
const fail = (rule, msg, file) => issues.push({ level: 'error', rule, msg, file })
const warn = (rule, msg, file) => issues.push({ level: 'warn', rule, msg, file })
const read = (p) => readFileSync(p, 'utf8')

/* ── 1. 预设必须显式实现六大维度 ───────────────────────────────── */
const DIMENSIONS = ['lighting', 'optics', 'spatial', 'surface', 'motion', 'promptModifiers']
const libraryPath = join(REMOTION, 'src/presets/library.tsx')
const presetIds = []
if (!existsSync(libraryPath)) {
  fail('preset/library', '缺少 remotion/src/presets/library.tsx')
} else {
  const src = read(libraryPath)
  // 按 `makePreset({` 切块，逐块检查六维度是否出现
  const blocks = src.split(/makePreset\(\{/).slice(1)
  if (blocks.length === 0) fail('preset/library', 'library.tsx 里没有 makePreset(...) 调用')
  for (const block of blocks) {
    const idMatch = block.match(/id:\s*'([^']+)'/)
    const id = idMatch ? idMatch[1] : '(未命名)'
    if (id !== '(未命名)') presetIds.push(id)
    const missing = DIMENSIONS.filter((d) => !new RegExp(`\\b${d}\\s*:`).test(block))
    if (missing.length) {
      fail('preset/dimensions', `预设 ${id} 缺少维度：${missing.join(', ')}（docs/visual-quality-standard.md §3 要求六维显式声明）`, 'remotion/src/presets/library.tsx')
    }
  }
  // 内置 id 集合
  const expected = ['cinematic-realism', 'editorial-minimal', 'anime-atmospheric', 'cyber-neon', 'oriental-ink', 'video-first']
  const lost = expected.filter((id) => !presetIds.includes(id))
  if (lost.length) fail('preset/registry', `library.tsx 缺少必备预设：${lost.join(', ')}`, 'remotion/src/presets/library.tsx')
}

/* ── 2. 预设与上游提示词 id 必须一致 ───────────────────────────── */
const promptsPath = join(ROOT, 'src/bridge/style-prompts.ts')
if (!existsSync(promptsPath)) {
  fail('prompts/missing', '缺少 src/bridge/style-prompts.ts')
} else {
  const src = read(promptsPath)
  const ids = [...src.matchAll(/^\s{2}'([a-z0-9-]+)':\s*(?:profile\(|\{)/gm)].map((m) => m[1])
  if (!ids.length) fail('prompts/parse', 'style-prompts.ts 里没解析到任何 STYLE_PROMPTS 条目')
  for (const id of ids) {
    if (presetIds.length && !presetIds.includes(id)) {
      fail('prompts/id-mismatch', `style-prompts 里的 ${id} 在 remotion 预设里不存在（两侧 id 必须一致）`, 'src/bridge/style-prompts.ts')
    }
  }
  if (!/抹|噪点|水印/.test(src)) warn('prompts/negative', 'style-prompts 的 negative 里没看到"涂抹/噪点/水印"类词')
}

/* ── 3. production 工作流必须是真模型 ──────────────────────────── */
const workflowDir = join(ROOT, '..', '..', 'workflows')
const REQUIRED = {
  'dsh-depth-v2.api.json': 'DshDepthModel',
  'dsh-matte-v2.api.json': 'LoadBackgroundRemovalModel',
  'dsh-plate.api.json': 'DshLayerSplit',
}
for (const [file, node] of Object.entries(REQUIRED)) {
  const p = join(workflowDir, file)
  if (!existsSync(p)) {
    warn('workflow/missing', `缺少 production 工作流 ${file}（ComfyUI 相关步骤会跳过）`, p)
    continue
  }
  if (!read(p).includes(node)) {
    fail('workflow/pseudo', `${file} 里没有真模型节点 ${node}`, p)
  }
}
for (const pseudo of ['dsh-depth.api.json', 'dsh-matte.api.json']) {
  const p = join(workflowDir, pseudo)
  if (existsSync(p)) {
    const src = read(join(ROOT, 'src/bridge/compiler.ts'))
    if (!src.includes(pseudo)) {
      fail('workflow/pseudo-guard', `${pseudo} 存在但 compiler 没有把它列入 PSEUDO_WORKFLOWS 拦截`, 'src/bridge/compiler.ts')
    }
  }
}

/* ── 4. 人为颗粒 = 画质红线 ───────────────────────────────────── */
function scanGrain(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanGrain(p)
      continue
    }
    if (!/\.(tsx?|ts)$/.test(entry.name)) continue
    const src = read(p)
    for (const m of src.matchAll(/grain:\s*([0-9.]+)/g)) {
      const value = Number(m[1])
      if (value > 0.02) fail('postfx/grain', `grain=${value} 超过 0.02（人为颗粒是画质红线）`, p)
    }
    for (const m of src.matchAll(/contrast:\s*([0-9.]+)/g)) {
      const value = Number(m[1])
      if (value > 1.25) fail('postfx/contrast', `contrast=${value} 超过 1.25（会把高光压死）`, p)
    }
    for (const m of src.matchAll(/saturation:\s*([0-9.]+)/g)) {
      const value = Number(m[1])
      if (value > 1.2) fail('postfx/saturation', `saturation=${value} 超过 1.2（肤色/自然色会失真）`, p)
    }
    if (/luakay/i.test(src) && !/BLEND_ALIASES|别名/.test(src)) {
      warn('blend/typo', '出现 luakay 拼写而本文件没有别名处理（应为 lumaKey）', p)
    }
  }
}
if (existsSync(join(REMOTION, 'src'))) scanGrain(join(REMOTION, 'src'))

/* ── 5. 色彩管线：ACES 之后必须有 sRGB 编码 ──────────────────── */
const glslPath = join(REMOTION, 'src/engine/glsl.ts')
if (existsSync(glslPath)) {
  const src = read(glslPath)
  if (/aces\(/.test(src) && !/1\.055\s*\*\s*pow|12\.92/.test(src)) {
    fail('color/srgb', 'COMPOSITE_FRAG 用 ACES 但没做线性→sRGB 编码（历史 bug：整片发灰）', glslPath)
  }
} else {
  fail('color/missing', '缺少 remotion/src/engine/glsl.ts')
}

/* ── 6. 引擎确定性：禁真实时钟 ───────────────────────────────── */
function scanDeterminism(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDeterminism(p)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    const src = read(p)
    // 只看代码行：`//` 或 `*` 开头的注释里提到这个 API 是允许的（文档化历史 bug）
    const codeLines = src.split('\n').filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    if (codeLines.some((line) => /clock\.elapsedTime/.test(line))) {
      fail('determinism/clock', '使用了 state.clock.elapsedTime（同帧两次渲染会不一致）', p)
    }
    if (/Math\.random\(\)/.test(src)) fail('determinism/random', '使用了 Math.random()（请用 mulberry32(seed)）', p)
    if (/\bDate\.now\(\)/.test(src)) warn('determinism/date', '出现 Date.now()（渲染路径里应避免）', p)
  }
}
if (existsSync(join(REMOTION, 'src/engine'))) scanDeterminism(join(REMOTION, 'src/engine'))

/* ── 7. plan 校验（可选） ────────────────────────────────────── */
const KNOWN_PRESETS = new Set([...presetIds, 'spatial', 'parallax', 'video-first'])
const KNOWN_BLENDS = new Set(['normal', 'additive', 'multiply', 'lumaKey', 'screen'])
function checkPlanFile(file) {
  let plan
  try {
    plan = JSON.parse(read(file))
  } catch (err) {
    fail('plan/json', `解析失败：${err.message}`, file)
    return
  }
  if (plan.version !== 1) warn('plan/version', `version=${plan.version}（期望 1）`, file)
  if (!KNOWN_PRESETS.has(plan.preset)) fail('plan/preset', `未知 preset=${plan.preset}`, file)
  let cursor = 0
  for (const shot of plan.shots ?? []) {
    if (shot.from !== cursor) warn('plan/timeline', `镜头 ${shot.id} from=${shot.from} 与游标 ${cursor} 不一致`, file)
    cursor = shot.from + shot.durationInFrames
    const hasLayer = Boolean(shot.layer?.src)
    const hasVideo = Boolean(shot.video?.src)
    if (!hasLayer && !hasVideo) fail('plan/empty-shot', `镜头 ${shot.id} 既没有 layer 也没有 video`, file)
    if (shot.video?.blend && !KNOWN_BLENDS.has(shot.video.blend)) {
      fail('plan/blend', `镜头 ${shot.id} 的 blend=${shot.video.blend} 非法`, file)
    }
    if (shot.video?.src && (shot.video.opacity ?? 1) > 0.75 && !shot.video.blend) {
      warn('plan/video-cover', `镜头 ${shot.id} 视频层不透明铺满，检查是否符合 docs/visual-quality-standard.md §1.4`, file)
    }
  }
  if (plan.durationInFrames && cursor !== plan.durationInFrames) {
    warn('plan/duration', `镜头总时长 ${cursor} ≠ durationInFrames ${plan.durationInFrames}`, file)
  }
}
const args = process.argv.slice(2)
const planArg = args.find((a) => a.startsWith('--plan='))?.slice('--plan='.length)
if (planArg) checkPlanFile(resolve(planArg))
if (args.includes('--all-plans')) {
  const dir = join(REMOTION, 'public/forge')
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const p = join(dir, entry.name, 'plan.json')
      if (existsSync(p)) checkPlanFile(p)
    }
  }
}

/* ── 汇总 ───────────────────────────────────────────────────── */
const errors = issues.filter((i) => i.level === 'error')
const warns = issues.filter((i) => i.level === 'warn')
const strict = args.includes('--strict')
if (issues.length === 0) {
  console.log('✅ 画质门禁通过：预设六维度 / 提示词 id / 真模型工作流 / 颗粒与调色默认值 / 色彩管线 / 确定性 全部合规')
} else {
  for (const i of issues) {
    const tag = i.level === 'error' ? '✗' : '!'
    console.log(`${tag} [${i.rule}] ${i.msg}${i.file ? `\n    → ${i.file}` : ''}`)
  }
  console.log(`\n合计：${errors.length} error / ${warns.length} warn`)
}
process.exit(errors.length > 0 || (strict && warns.length > 0) ? 1 : 0)
