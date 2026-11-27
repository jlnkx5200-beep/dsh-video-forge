/**
 * 自动化资产生成管线编译器。
 *
 * 输入：分镜数据（video-shotcraft 的分镜表 / 手写 shot 数组 / 从 markdown 解析出来的表格）
 * 输出：① TaskNode DAG（交给 Scheduler 跑）② RenderPlan 骨架（资产槽先空着，跑完回填）
 *
 * 关键设计：
 * - **每镜头可单独覆写**（override）：某个镜头想纯 MiniMax 直出，就把 strategy 设成 minimax-direct；
 *   想走 ComfyUI 自定义节点管线就设 comfy-pipeline。编译器只负责把策略翻译成 DAG 形状。
 * - **确定性**：seed = hash(planId + shotId + role)，同一分镜永远同一随机种子，便于复现与缓存命中。
 * - **可选性**：深度/抠图是"锦上添花"，失败不该炸掉整片，所以 optional=true + fallback='skip'；
 *   静帧与视频是"必须有"，失败即中断（或按调用方要求降级）。
 */
import { createHash } from 'node:crypto'
import type { TaskNode } from '../core/scheduler.js'
import type {
  CameraKeyframe, RenderPlan, ShotCamera, ShotPlan, ShotPostFX, ShotStrategy, ShotTransition,
} from './render-plan.js'
import { layoutDurations } from './render-plan.js'
import { composeStyledPrompt } from './style-prompts.js'

export interface StoryboardShot {
  id?: string
  /** 镜别（wide / medium / close-up / macro / insert） */
  shot?: string
  /** 时长（秒） */
  durationSec?: number
  /** 起止时间字符串（"0-3s" / "3s-6s"），无 durationSec 时用它推 */
  time?: string
  /** 画面内容（喂给模型的主提示词；缺省用 link/description） */
  prompt?: string
  description?: string
  /** 运镜名（dolly-in / orbit / pan / crane-up / handheld / static） */
  move?: string
  /** 转场描述（crossfade / radial-blur / luma-wipe / noise-dissolve / push） */
  transition?: string
  /** 风格标签（透传，不参与分支） */
  styleTags?: string[]
  /** 生成策略（默认 seedream-static） */
  strategy?: ShotStrategy
  /** MAGI-2 多模态参考（本地路径 / 公网 URL / assetId）：≤10 图、≤5 视频(总长≤30s)、≤5 音频(总长≤30s)、合计≤20 */
  referenceImages?: string[]
  referenceVideos?: string[]
  referenceAudios?: string[]
  /** MAGI-2 首帧 / 尾帧：一旦指定，自动路由到 Ark 兼容端点（且禁止与多参考混传） */
  firstFrame?: string
  lastFrame?: string
  /** 是否让 MAGI-2 生成音轨；false 时成品是无音轨 MP4（产物 meta.hasAudio=false） */
  generateAudio?: boolean
  /** MAGI-2 时间轴分镜：[{atSec, prompt}] */
  timelineCues?: Array<{ atSec: number; prompt: string }>
  /** 覆写底层参数：seedream / minimax / comfy 三段各自透传 */
  override?: {
    /** 该镜头是否启用「主体/背景板」拆分（默认跟随 options.enablePlate） */
    plate?: boolean
    seedream?: Record<string, unknown>
    minimax?: Record<string, unknown>
    magi2?: Record<string, unknown>
    comfy?: Record<string, unknown>
  }
  /** 混合模式（有视频时） */
  blend?: 'normal' | 'additive' | 'multiply' | 'lumaKey'
  /** 后处理栈 */
  postFX?: ShotPostFX[]
  /** 参考图（I2I 起点，走 Seedream image 字段） */
  referenceImage?: string
  caption?: string
}

export interface StoryboardInput {
  id?: string
  title?: string
  width?: number
  height?: number
  fps?: number
  preset?: string
  style?: {
    tags?: string[]
    palette?: string[]
    fogColor?: string
    background?: string
  }
  audio?: { src?: string; volume?: number; beats?: number[] }
  shots: StoryboardShot[]
}

export interface CompileOptions {
  /** 默认走全套管线（静帧→深度/抠图→I2V）；'still-3d' 出纯静帧+3D 运镜（零视频成本） */
  defaultStrategy?: ShotStrategy
  /** 是否在 prompt 里附加风格标签（默认 true，但只用标签词，不套模板句） */
  appendStyleTags?: boolean
  /** Seedream 模型别名 */
  seedreamModel?: string
  /** MiniMax 模型 */
  minimaxModel?: string
  /** MiniMax 分辨率 */
  minimaxResolution?: string
  /** MAGI-2 模型 id（缺省 MiniMax 之外的另一家：MAGI-2） */
  magi2Model?: string
  /** MAGI-2 默认时长（4–30 整数秒；镜头 durationSec 优先） */
  magi2Duration?: number
  /** MAGI-2 是否生成音轨（默认 true） */
  generateAudio?: boolean
  /** ComfyUI 工作流名（depth / matte / plate）；空则跳过深度/抠图 */
  depthWorkflow?: string
  matteWorkflow?: string
  /** 背景板工作流（前景剥离 + 洞口修复）；production 下有 matte 就应当配它 */
  plateWorkflow?: string
  /** 是否真的执行背景板剥离（默认 false：风景/大场景不需要，且 BiRefNet 无主体时会毁背景） */
  enablePlate?: boolean
  /** 风格预设 id（决定 prompt 锚点与下游渲染观感） */
  preset?: string
  /**
   * 质量模式：
   *  - production：画质红线生效 —— 禁伪深度/伪抠像工作流、禁 480P 糊屏、提示缺真模型
   *  - draft：允许快速试排（可用伪算法工作流、允许 480P），产出的 plan 会带 draft 标记
   */
  qualityMode?: 'production' | 'draft'
  /** 是否把负向去噪词拼进 prompt（默认 true） */
  promptWithNegative?: boolean
}

/** 伪算法工作流：只能在 draft 模式下用（亮度+Sobel 伪深度 / 纯亮度抠像）。 */
const PSEUDO_WORKFLOWS = new Set(['dsh-depth.api.json', 'dsh-matte.api.json'])

/** 低于 768P 的视频在 1080p 成片里必然糊，production 模式拒绝。 */
const LOW_RES_VIDEO = new Set(['480P', '360P'])

export interface CompiledPipeline {
  plan: RenderPlan
  tasks: TaskNode[]
  issues: Array<{ level: 'warn' | 'error'; shotId?: string; message: string }>
}

function hashInt(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function parseSeconds(value: string | undefined): [number, number] | null {
  if (value === undefined) return null
  const m = /(\d+(?:\.\d+)?)\s*s?\s*[-~–—]\s*(\d+(?:\.\d+)?)\s*s?/i.exec(value)
  if (m === null) return null
  return [Number(m[1]), Number(m[2])]
}

/** 运镜名 → 起止机位（世界单位）。确定性：同 move + 同 seed 恒等。 */
export function cameraFor(move: string, seed: number, parallax = 0.5): ShotCamera {
  const key = move.toLowerCase()
  const jitter = (offset: number): number => ((hashInt(move + ':' + seed + ':' + offset) % 1000) / 1000 - 0.5) * 0.16
  const z = -6 - parallax * 3
  const from: CameraKeyframe = { position: [jitter(1), 0.2 + jitter(2), 0], lookAt: [0, 0, z] }
  const to: CameraKeyframe = { position: [jitter(3) * 0.6, 0.1 + jitter(4), 0], lookAt: [0, 0, z] }
  let fov = 42

  if (key.includes('dolly') && key.includes('in')) {
    from.position[2] = 2.2
    to.position[2] = -0.6
  } else if (key.includes('dolly') && key.includes('out')) {
    from.position[2] = -0.8
    to.position[2] = 2.6
  } else if (key.includes('orbit')) {
    from.position = [2.6, 0.35, 1.6]
    to.position = [-2.4, 0.15, 1.9]
  } else if (key.includes('pan')) {
    from.position = [-2.2, 0.1, 0.4]
    to.position = [2.2, 0.1, 0.4]
  } else if (key.includes('crane') || key.includes('tilt')) {
    from.position = [0, -1.1, 0.9]
    to.position = [0, 1.3, 0.2]
  } else if (key.includes('handheld')) {
    from.position = [jitter(5) * 2, 0.05, 0.8]
    to.position = [jitter(6) * 2, -0.05, 0.5]
    fov = 46
  } else if (key.includes('static') || key === '') {
    from.position[2] = 0.8
    to.position[2] = 0.8
    fov = 38
  } else {
    // 未知运镜：给一个稳的轻推，不炸
    from.position[2] = 1.4
    to.position[2] = 0.2
  }
  return { move: move === '' ? 'static' : move, from, to, fov, easing: 'smooth' }
}

function transitionFor(type: string | undefined, fps: number): ShotTransition | undefined {
  if (type === undefined || type.trim() === '') return undefined
  const key = type.toLowerCase()
  const known = ['crossfade', 'radial-blur', 'luma-wipe', 'noise-dissolve', 'push']
  const found = known.find(k => key.includes(k)) ?? 'crossfade'
  const direction = key.includes('right') ? 'right' : key.includes('up') ? 'up' : key.includes('down') ? 'down' : 'left'
  return { type: found, durationInFrames: Math.max(6, Math.round(fps * 0.5)), direction }
}

/**
 * 景别归一化。
 *
 * 分镜表里那一格通常写的是「建立镜头：雾中显形」这种人类描述，直接塞进 `shotSize`
 * 会让渲染侧没法按景别做任何判断（比如特写要不要加浅景深）。这里按关键词归到
 * wide / medium / close / macro 四档，原文仍保留在 description 里。
 */
export function normalizeShotSize(text: string | undefined): string {
  const key = (text ?? '').toLowerCase()
  if (key === '') return 'medium'
  if (/macro|extreme|大特写|微距/.test(key)) return 'macro'
  if (/close|特写|近景|脸部|细节/.test(key)) return 'close'
  if (/wide|establish|全景|远景|建立|大全|空镜/.test(key)) return 'wide'
  if (/medium|中景|半身|人物/.test(key)) return 'medium'
  return 'medium'
}

function composePrompt(shot: StoryboardShot, options: CompileOptions, index: number, shotSize: string): string {
  const base = (shot.prompt ?? shot.description ?? '').trim()
  return composeStyledPrompt({
    base: base !== '' ? base : '第 ' + (index + 1) + ' 个镜头',
    presetId: options.preset,
    styleTags: (options.appendStyleTags ?? true) ? (shot.styleTags ?? []) : [],
    shotSize,
    withNegative: options.promptWithNegative,
  })
}

function seedFor(planId: string, shotId: string, role: string): number {
  return hashInt(planId + '|' + shotId + '|' + role) % 2147483647
}

export function compileStoryboard(input: StoryboardInput, options: CompileOptions = {}): CompiledPipeline {
  const issues: CompiledPipeline['issues'] = []
  const fps = input.fps ?? 30
  const planId = input.id ?? 'plan-' + (hashInt(JSON.stringify(input.shots.map(s => s.prompt ?? s.description ?? s.id ?? ''))) % 100000).toString(36)
  const defaultStrategy = options.defaultStrategy ?? 'seedream-static'
  const qualityMode = options.qualityMode ?? 'production'
  const production = qualityMode === 'production'
  const styleTags = input.style?.tags ?? []

  // ── 画质红线（docs/visual-quality-standard.md）：production 模式下先做工作流体检，不合格直接报错而不是静默降级
  if (production) {
    for (const [kind, name] of [['深度', options.depthWorkflow], ['抠像', options.matteWorkflow]] as const) {
      if (name !== undefined && PSEUDO_WORKFLOWS.has(name)) {
        issues.push({
          level: 'error',
          message: `production 模式禁止使用伪算法${kind}工作流 ${name}：` +
            `请改用 ${kind === '深度' ? 'dsh-depth-v2.api.json（Depth Anything V2）' : 'dsh-matte-v2.api.json（BiRefNet）'}；` +
            '若只是快速试排，请显式传 qualityMode=draft。',
        })
      }
    }
    const res = options.minimaxResolution ?? '768P'
    if (LOW_RES_VIDEO.has(res)) {
      issues.push({
        level: 'warn',
        message: `production 模式下视频分辨率 ${res} 在 1080p 成片里会明显发糊，已自动提升到 768P（可用 draft 模式保留低清试排）`,
      })
    }
  }

  // MAGI-2 端点体检：首尾帧与多参考混传会被官方拒绝，编译期就拦住（而不是等 400 才发现）
  for (const [index, shot] of input.shots.entries()) {
    const shotId = shot.id ?? 'shot-' + (index + 1)
    const hasFrame = shot.firstFrame !== undefined || shot.lastFrame !== undefined
    const hasRefs = (shot.referenceImages?.length ?? 0) + (shot.referenceVideos?.length ?? 0) + (shot.referenceAudios?.length ?? 0) > 0
    if (hasFrame && hasRefs) {
      issues.push({
        level: 'error',
        shotId,
        message: '首尾帧（firstFrame/lastFrame）与多模态参考不能混传：首尾帧走 Ark 兼容端点，多参考走 Native 端点，请二选一',
      })
    }
    const duration = Number(shot.durationSec)
    if (Number.isFinite(duration) && duration > 30) {
      issues.push({ level: 'warn', shotId, message: 'MAGI-2 单镜最长 30s，超长部分会被截断为 30s' })
    }
  }

  const durations: number[] = []
  for (const [index, shot] of input.shots.entries()) {
    const span = parseSeconds(shot.time)
    const explicit = Number(shot.durationSec)
    let duration = Number.isFinite(explicit) && explicit > 0 ? explicit : span !== null ? Math.max(1, span[1] - span[0]) : NaN
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = 3
      issues.push({ level: 'warn', shotId: shot.id ?? 'shot-' + (index + 1), message: '缺时长，按 3s 处理' })
    }
    // 单镜时长：H3 上限 15s；MAGI-2 支持 4–30s，故按策略放宽（最终仍由各 Provider 再夹一次）
    const isMagi2Shot = (shot.strategy ?? '') === 'magi2-direct' || (shot.strategy ?? '') === 'magi2-i2v'
    durations.push(Math.min(isMagi2Shot ? 30 : 15, Math.max(1, duration)))
  }
  const slots = layoutDurations(durations, fps)

  const tasks: TaskNode[] = []
  const shots: ShotPlan[] = []

  for (const [index, raw] of input.shots.entries()) {
    const slot = slots[index]!
    const shotId = (raw.id ?? 'shot-' + String(index + 1).padStart(2, '0')).trim()
    // 显式给了首尾帧却没写策略 → 自动按 magi2-i2v 走（首尾帧只有 MAGI-2 的 Ark 兼容端点支持）
    const hasFrames = raw.firstFrame !== undefined || raw.lastFrame !== undefined
    const strategy: ShotStrategy = raw.strategy ?? (hasFrames ? 'magi2-i2v' : defaultStrategy)
    const move = raw.move ?? 'dolly-in'
    const parallax = strategy === 'still-3d' ? 0.35 : 0.6
    const camera = cameraFor(move, seedFor(planId, shotId, 'camera'), parallax)
    const shotSize = normalizeShotSize(raw.shot)
    const prompt = composePrompt(raw, options, index, shotSize)
    const stillSeed = seedFor(planId, shotId, 'still')
    const override = raw.override ?? {}

    const stillId = shotId + ':still'
    const depthId = shotId + ':depth'
    const matteId = shotId + ':matte'
    const videoId = shotId + ':video'

    const shot: ShotPlan = {
      id: shotId,
      index,
      from: slot.from,
      durationInFrames: slot.durationInFrames,
      strategy,
      shotSize,
      description: raw.description ?? raw.shot ?? prompt,
      camera,
      postFX: raw.postFX ?? [],
      transitionIn: index === 0 ? undefined : transitionFor(raw.transition, fps),
      caption: raw.caption,
      assets: {},
    }

    const isMagi2 = strategy === 'magi2-direct' || strategy === 'magi2-i2v'
    // 2K 重绘：先出静帧当首帧，再让 H3 以 2K 直出 —— 上游 768P 的锐度天花板由它兜底
    const is2kRepaint = strategy === 'minimax-2k-repaint'
    // MAGI-2 直出（T2V/多参考）不需要静帧；图生视频需要静帧当首帧（除非镜头自己给了首帧）
    const needStill = isMagi2
      // MAGI-2：直出无静帧；图生视频若镜头自带首帧就不再生成静帧（避免白花一次出图钱）
      ? (!hasFrames && strategy === 'magi2-i2v')
      : strategy !== 'minimax-direct'
    const needDepth = strategy === 'seedream-static' || strategy === 'comfy-pipeline'
    const wantPlate = options.enablePlate === true || override.plate === true
    // plate（背景板剥离）本质上是"用 matte 把主体从背景里抠出来"：想开 plate 就必须有 matte 任务，
    // 否则 DAG 里会出现指向不存在节点的依赖（任务 s1:plate 依赖了不存在的 s1:matte）。
    const needMatte = strategy === 'comfy-pipeline'
      || (wantPlate && production && options.matteWorkflow !== undefined && options.matteWorkflow !== '')
    const needVideo = strategy === 'minimax-direct' || strategy === 'comfy-pipeline' || isMagi2 || is2kRepaint
    // MAGI-2 走 Native 端点还是 Ark 兼容端点由"有没有首尾帧"决定（编译器只算意图，Provider 再兜一层）
    const magi2Mode: 'ark' | 'native' = hasFrames || strategy === 'magi2-i2v' ? 'ark' : 'native'

    if (needStill) {
      tasks.push({
        id: stillId,
        provider: 'seedream',
        kind: 'image',
        params: {
          prompt,
          model: options.seedreamModel ?? '5.0-flash',
          size: (input.width ?? 1920) + 'x' + (input.height ?? 1080),
          count: 1,
          seed: stillSeed,
          ...(raw.referenceImage === undefined ? {} : { image: raw.referenceImage }),
          ...(override.seedream ?? {}),
        },
        // 静帧是主干，失败必须显式（不自动降级，避免"占位图冒充出片"）
        retries: 2,
      })
    }

    if (needDepth) {
      if (options.depthWorkflow === undefined || options.depthWorkflow === '') {
        issues.push({ level: 'warn', shotId, message: '需要深度图但没有配置 depthWorkflow，视差将按亮度近似' })
      } else {
        tasks.push({
          id: depthId,
          provider: 'comfyui',
          kind: 'asset',
          needs: [{ role: 'source', from: stillId }],
          params: {
            workflowName: options.depthWorkflow,
            context: { planId, shotId, width: input.width ?? 1920, height: input.height ?? 1080 },
            strict: true,
            ...(override.comfy ?? {}),
          },
          optional: true,
          fallback: 'skip',
          retries: 1,
        })
      }
    }

    if (needMatte) {
      if (options.matteWorkflow === undefined || options.matteWorkflow === '') {
        issues.push({ level: 'warn', shotId, message: '需要抠图但没配置 matteWorkflow，将不做透明通道' })
      } else {
        tasks.push({
          id: matteId,
          provider: 'comfyui',
          kind: 'asset',
          needs: [{ role: 'source', from: stillId }],
          params: {
            workflowName: options.matteWorkflow,
            context: { planId, shotId, width: input.width ?? 1920, height: input.height ?? 1080 },
            strict: true,
            ...(override.comfy ?? {}),
          },
          optional: true,
          fallback: 'skip',
          retries: 1,
        })
      }
    }

    if (wantPlate && production && options.matteWorkflow !== undefined && options.matteWorkflow !== '') {
      const plateWorkflow = options.plateWorkflow ?? 'dsh-plate.api.json'
      tasks.push({
        id: shotId + ':plate',
        provider: 'comfyui',
        kind: 'asset',
        needs: [
          { role: 'source', from: stillId },
          { role: 'mask', from: matteId },
        ],
        params: {
          workflowName: plateWorkflow,
          context: { planId, shotId, width: input.width ?? 1920, height: input.height ?? 1080 },
          strict: true,
          ...(override.comfy ?? {}),
        },
        // 背景板失败不炸整片，但没有它 2.5D 会有边缘撕裂 —— 降级要显式提示
        optional: true,
        fallback: 'skip',
        retries: 1,
      })
      shot.assets.plate = ''
    } else if (wantPlate && production) {
      issues.push({ level: 'warn', shotId, message: '开启了背景板但没配置 matteWorkflow：plate 需要 matte 才能拆分前景/背景，已跳过' })
    } else if (wantPlate && !production) {
      issues.push({ level: 'warn', shotId, message: 'draft 模式跳过背景板（plate）' })
    } else if (needMatte && !wantPlate) {
      issues.push({ level: 'warn', shotId, message: '未开启背景板剥离（enablePlate=false）：按整帧单层渲染，避免无主体场景被抠成半透明' })
    }

    if (needVideo && isMagi2) {
      // ── MAGI-2：首帧取本镜静帧（I2V）或镜头显式首帧；多参考只在 Native 模式生效
      const wantsArk = magi2Mode === 'ark'
      const needs: Array<{ role: string; from: string }> = []
      if (raw.firstFrame === undefined && needStill) needs.push({ role: 'first_frame', from: stillId })
      const durationSec = Math.max(4, Math.min(30, Math.round(slot.durationInFrames / fps)))
      const magi2Params: Record<string, unknown> = {
        prompt,
        mode: wantsArk ? 'ark' : 'native',
        model: options.magi2Model ?? 'MAGI-2',
        duration: durationSec,
        resolution: '1080p',
        ratio: '16:9',
        generateAudio: raw.generateAudio ?? options.generateAudio ?? true,
        seed: stillSeed,
        ...(raw.firstFrame === undefined ? {} : { firstFrame: raw.firstFrame }),
        ...(raw.lastFrame === undefined ? {} : { lastFrame: raw.lastFrame }),
        ...(raw.timelineCues === undefined ? {} : { timelineCues: raw.timelineCues }),
        // Ark 端点严格禁止与多参考混传：只在 native 分支带参考
        ...(wantsArk
          ? {}
          : {
              ...(raw.referenceImages === undefined ? {} : { referenceImages: raw.referenceImages }),
              ...(raw.referenceVideos === undefined ? {} : { referenceVideos: raw.referenceVideos }),
              ...(raw.referenceAudios === undefined ? {} : { referenceAudios: raw.referenceAudios }),
            }),
        ...(override.magi2 ?? {}),
      }
      tasks.push({
        id: videoId,
        provider: 'magi2',
        kind: 'video',
        needs,
        params: magi2Params,
        retries: 1,
      })
      shot.video = { src: '', blend: raw.blend ?? 'normal', opacity: 1 }
    } else if (needVideo) {
      const firstFrameFrom = needStill ? stillId : undefined
      tasks.push({
        id: videoId,
        provider: 'minimax',
        kind: 'video',
        needs: firstFrameFrom === undefined ? [] : [{ role: 'first_frame', from: firstFrameFrom }],
        params: {
          prompt,
          model: options.minimaxModel ?? 'MiniMax-H3',
          resolution: is2kRepaint
            ? '2K'
            : production
              ? (LOW_RES_VIDEO.has(options.minimaxResolution ?? '768P') ? '768P' : (options.minimaxResolution ?? '768P'))
              : (options.minimaxResolution ?? '768P'),
          duration: Math.max(4, Math.min(15, Math.round(slot.durationInFrames / fps))),
          // 纯文本场景官方不接受 adaptive（会 400），统一显式给画幅
          ratio: '16:9',
          ...(override.minimax ?? {}),
        },
        retries: 1,
      })
      shot.video = { src: '', blend: raw.blend ?? 'normal', opacity: 1 }
    }

    if (needStill) {
      shot.layer = { src: '', parallax, depth: 0 }
    }

    shots.push(shot)
  }

  const totalFrames = slots.reduce((sum, slot) => sum + slot.durationInFrames, 0)
  const plan: RenderPlan = {
    version: 1,
    id: planId,
    title: input.title ?? 'Forge Plan',
    width: input.width ?? 1920,
    height: input.height ?? 1080,
    fps,
    durationInFrames: totalFrames,
    preset: input.preset ?? 'depth-parallax',
    style: {
      tags: styleTags,
      palette: input.style?.palette ?? ['#0b0f19', '#1b2740', '#e8ecf5'],
      fogColor: input.style?.fogColor,
      background: input.style?.background,
    },
    audio: input.audio,
    shots,
    provenance: {
      compiler: 'dsh-video-forge/bridge/compiler',
      strategy: defaultStrategy,
      shots: input.shots.length,
      videoEngines: [...new Set(shots.filter(s => s.video !== undefined).map(s => (s.strategy.startsWith('magi2') ? 'magi2' : 'minimax')))],
    },
    createdAt: new Date(0).toISOString(),
  }

  return { plan, tasks, issues }
}

/**
 * 解析 video-shotcraft 的分镜表（markdown）：
 *   | # | 时间 | 镜头 | 关键动效 |
 *   | 1 | 0-3s | 产品特写推近 | dolly-in + bloom |
 * 只做"能确定的提取"：镜别/运镜/转场名；画面描述列存 description，人再补 prompt。
 */
export function parseStoryboardTable(markdown: string): StoryboardShot[] {
  const lines = markdown.split(/\r?\n/).filter(line => line.trim().startsWith('|'))
  if (lines.length < 3) return []
  const header = lines[0]!.split('|').map(cell => cell.trim()).filter(cell => cell !== '')
  const body = lines.slice(2)
  const col = (name: string): number => header.findIndex(cell => cell.includes(name))
  const iTime = col('时间')
  const iShot = col('镜头')
  const iEffect = col('关键动效')
  const iIndex = col('#')
  const shots: StoryboardShot[] = []
  for (const line of body) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length === 0) continue
    const pick = (i: number): string => (i >= 0 ? cells[i] ?? '' : '')
    const effect = pick(iEffect)
    const move = ['dolly-in', 'dolly-out', 'orbit', 'pan', 'crane-up', 'handheld', 'static']
      .find(name => effect.toLowerCase().includes(name.split('-')[0]!)) ?? 'dolly-in'
    shots.push({
      id: pick(iIndex) === '' ? undefined : 'shot-' + pick(iIndex),
      time: pick(iTime) === '' ? undefined : pick(iTime),
      shot: pick(iShot) === '' ? undefined : pick(iShot).slice(0, 24),
      description: pick(iShot),
      move,
      transition: ['crossfade', 'radial-blur', 'luma-wipe', 'noise-dissolve', 'push'].find(name => effect.toLowerCase().includes(name)) ?? undefined,
    })
  }
  return shots
}

export function planHash(plan: RenderPlan): string {
  return createHash('sha256').update(JSON.stringify({ ...plan, createdAt: undefined })).digest('hex').slice(0, 16)
}
