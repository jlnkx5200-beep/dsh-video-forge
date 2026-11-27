/**
 * 防御式解析：任何外部输入（宿主产物 / 用户手写 / 旧版本 plan）都先过这里。
 *
 * 原则：
 *   - **永不 throw 在可修复的问题上**：缺 fov 给 42，缺 camera 给 static，缺 preset 给 'cinematic-realism'
 *   - 只在结构性错误（没有 shots、宽高非法）时给 error 级 issue，由调用方决定是否继续
 *   - 所有数值都夹紧到安全区间，避免 NaN 进入 three 后整帧黑屏
 */
import type { BlendMode, CameraKeyframe, ParsedPlan, PlanIssue, RenderPlan, ShotCamera, ShotPlan, ShotTransition } from './types'

const KNOWN_STRATEGIES = [
  'seedream-static', 'still-3d', 'comfy-pipeline',
  'minimax-direct', 'minimax-2k-repaint', 'magi2-direct', 'magi2-i2v',
]
const KNOWN_BLENDS: BlendMode[] = ['normal', 'additive', 'multiply', 'lumaKey']
/** 历史拼写（luakay）仍接受，映射到正确名字 lumaKey */
const BLEND_ALIASES: Record<string, BlendMode> = { luakay: 'lumaKey', lumakey: 'lumaKey' }
const KNOWN_TRANSITIONS = ['crossfade', 'radial-blur', 'luma-wipe', 'noise-dissolve', 'push']

function num(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function vec3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [...fallback] as [number, number, number]
  return [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])]
}

function keyframe(value: unknown, fallback: CameraKeyframe): CameraKeyframe {
  const raw = (value ?? {}) as Record<string, unknown>
  const out: CameraKeyframe = {
    position: vec3(raw.position, fallback.position),
    lookAt: vec3(raw.lookAt, fallback.lookAt),
  }
  if (raw.roll !== undefined) out.roll = num(raw.roll, 0, -180, 180)
  return out
}

function camera(value: unknown, issues: PlanIssue[], shotId: string): ShotCamera {
  const raw = (value ?? {}) as Record<string, unknown>
  const staticFrom: CameraKeyframe = { position: [0, 0.15, 0.8], lookAt: [0, 0, -6] }
  const from = keyframe(raw.from, staticFrom)
  const to = keyframe(raw.to, from)
  const easingRaw = str(raw.easing, 'smooth')
  const easing = easingRaw === 'linear' || easingRaw === 'easeInOut' ? easingRaw : 'smooth'
  const fov = num(raw.fov, 42, 1, 179)
  if (fov === 42 && raw.fov === undefined) {
    issues.push({ level: 'warn', shotId, message: '机位缺 fov，按 42° 处理' })
  }
  return { move: str(raw.move, 'static'), from, to, fov, easing }
}

function transition(value: unknown, issues: PlanIssue[], shotId: string): ShotTransition | undefined {
  if (value === undefined || value === null) return undefined
  const raw = value as Record<string, unknown>
  const typeRaw = str(raw.type, 'crossfade').toLowerCase()
  const type = KNOWN_TRANSITIONS.find(t => typeRaw.includes(t)) ?? 'crossfade'
  if (KNOWN_TRANSITIONS.every(t => !typeRaw.includes(t))) {
    issues.push({ level: 'warn', shotId, message: '未知转场「' + typeRaw + '」，回退 crossfade' })
  }
  const directionRaw = str(raw.direction, 'left')
  const direction = directionRaw === 'right' || directionRaw === 'up' || directionRaw === 'down' ? directionRaw : 'left'
  return {
    type,
    durationInFrames: Math.round(num(raw.durationInFrames, 12, 2, 120)),
    maskSrc: typeof raw.maskSrc === 'string' ? raw.maskSrc : undefined,
    direction,
  }
}

function shot(value: unknown, index: number, issues: PlanIssue[]): ShotPlan {
  const raw = (value ?? {}) as Record<string, unknown>
  const id = str(raw.id, 'shot-' + (index + 1))
  const strategyRaw = str(raw.strategy, 'seedream-static')
  const strategy = KNOWN_STRATEGIES.includes(strategyRaw) ? strategyRaw : 'seedream-static'
  if (!KNOWN_STRATEGIES.includes(strategyRaw)) {
    issues.push({ level: 'warn', shotId: id, message: '未知 strategy「' + strategyRaw + '」，回退 seedream-static' })
  }

  const assetsRaw = (raw.assets ?? {}) as Record<string, unknown>
  const assets: ShotPlan['assets'] = {}
  for (const key of ['still', 'depth', 'matte', 'normal', 'video', 'transitionMask'] as const) {
    const v = assetsRaw[key]
    if (typeof v === 'string' && v !== '') assets[key] = v
  }

  let layer: ShotPlan['layer'] | undefined
  if (raw.layer !== undefined && raw.layer !== null) {
    const l = raw.layer as Record<string, unknown>
    const src = str(l.src, assets.still ?? '')
    if (src !== '') {
      layer = {
        src,
        depthSrc: typeof l.depthSrc === 'string' ? l.depthSrc : assets.depth,
        matteSrc: typeof l.matteSrc === 'string' ? l.matteSrc : assets.matte,
        parallax: num(l.parallax, 0.5, 0, 2),
        depth: num(l.depth, 0, -50, 50),
      }
    }
  } else if (assets.still !== undefined) {
    layer = { src: assets.still, depthSrc: assets.depth, matteSrc: assets.matte, parallax: 0.5, depth: 0 }
  }

  let video: ShotPlan['video'] | undefined
  if (raw.video !== undefined && raw.video !== null) {
    const v = raw.video as Record<string, unknown>
    const src = str(v.src, assets.video ?? '')
    if (src !== '') {
      const blendRaw = str(v.blend, 'normal')
      const blend: BlendMode = KNOWN_BLENDS.includes(blendRaw as BlendMode)
        ? (blendRaw as BlendMode)
        : (BLEND_ALIASES[blendRaw.toLowerCase()] ?? 'normal')
      const chromaRaw = v.chromaKey as Record<string, unknown> | undefined
      video = {
        src,
        blend,
        opacity: num(v.opacity, 1, 0, 1),
        width: v.width === undefined ? undefined : num(v.width, 16, 0.1, 500),
        height: v.height === undefined ? undefined : num(v.height, 9, 0.1, 500),
        chromaKey: chromaRaw === undefined ? undefined : {
          color: str(chromaRaw.color, '#00ff00'),
          similarity: num(chromaRaw.similarity, 0.4, 0, 1),
          smoothness: num(chromaRaw.smoothness, 0.1, 0, 1),
        },
      }
    }
  }

  if (layer === undefined && video === undefined) {
    issues.push({ level: 'error', shotId: id, message: '镜头既没有静帧层也没有视频层，无法渲染' })
  }

  const plan: ShotPlan = {
    id,
    index,
    from: Math.round(num(raw.from, 0, 0, 1e6)),
    durationInFrames: Math.round(num(raw.durationInFrames, 90, 1, 1e6)),
    strategy,
    shotSize: typeof raw.shotSize === 'string' ? raw.shotSize : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    camera: camera(raw.camera, issues, id),
    postFX: Array.isArray(raw.postFX) ? raw.postFX.filter((p): p is string => typeof p === 'string') : [],
    transitionIn: transition(raw.transitionIn, issues, id),
    transitionOut: transition(raw.transitionOut, issues, id),
    caption: typeof raw.caption === 'string' ? raw.caption : undefined,
    assets,
  }
  if (layer !== undefined) plan.layer = layer
  if (video !== undefined) plan.video = video
  return plan
}

/** 把任意输入归一成可渲染的 RenderPlan。 */
export function parseRenderPlan(input: unknown): ParsedPlan {
  const issues: PlanIssue[] = []
  const raw = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>
  if (raw === null || typeof raw !== 'object') {
    return {
      plan: emptyPlan(),
      issues: [{ level: 'error', message: 'plan 不是一个对象' }],
    }
  }

  const version = num(raw.version, 1)
  const width = Math.round(num(raw.width, 1920, 16, 8192))
  const height = Math.round(num(raw.height, 1080, 16, 8192))
  const fps = Math.round(num(raw.fps, 30, 1, 120))
  const shotsRaw = Array.isArray(raw.shots) ? raw.shots : []
  const shots = shotsRaw.map((s, i) => shot(s, i, issues))
  if (shots.length === 0) issues.push({ level: 'error', message: 'plan 里没有任何镜头' })

  // 时间轴自愈：缺失 from 的按顺序累加；总长以最后一个镜头结尾为准
  let cursor = 0
  for (const s of shots) {
    if (s.from < cursor) s.from = cursor
    cursor = Math.max(cursor, s.from + s.durationInFrames)
  }
  for (let i = 0; i + 1 < shots.length; i += 1) {
    const cur = shots[i]!
    const next = shots[i + 1]!
    if (next.from !== cur.from + cur.durationInFrames) {
      issues.push({ level: 'warn', shotId: next.id, message: '时间轴不连续：前镜头结束 ' + (cur.from + cur.durationInFrames) + '，本镜头起点 ' + next.from })
    }
  }
  const declared = Math.round(num(raw.durationInFrames, cursor, 1, 1e7))
  if (shots.length > 0 && declared !== cursor) {
    issues.push({ level: 'warn', message: 'plan.durationInFrames=' + declared + ' 与实际镜头总长 ' + cursor + ' 不一致，按实际总长渲染' })
  }

  const styleRaw = (raw.style ?? {}) as Record<string, unknown>
  const plan: RenderPlan = {
    version,
    id: str(raw.id, 'plan'),
    title: str(raw.title, 'Video Forge Composition'),
    width,
    height,
    fps,
    durationInFrames: Math.max(1, cursor),
    preset: str(raw.preset, 'cinematic-realism'),
    style: {
      tags: Array.isArray(styleRaw.tags) ? styleRaw.tags.filter((t): t is string => typeof t === 'string') : [],
      palette: Array.isArray(styleRaw.palette) ? styleRaw.palette.filter((t): t is string => typeof t === 'string') : [],
      fogColor: typeof styleRaw.fogColor === 'string' ? styleRaw.fogColor : undefined,
      background: typeof styleRaw.background === 'string' ? styleRaw.background : undefined,
    },
    shots,
    provenance: (raw.provenance ?? {}) as Record<string, unknown>,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
  }
  const audioRaw = raw.audio as Record<string, unknown> | undefined
  if (audioRaw !== undefined && typeof audioRaw.src === 'string' && audioRaw.src !== '') {
    plan.audio = {
      src: audioRaw.src,
      volume: num(audioRaw.volume, 1, 0, 4),
      beats: Array.isArray(audioRaw.beats) ? audioRaw.beats.filter((b): b is number => typeof b === 'number') : [],
    }
  }
  return { plan, issues }
}

export function emptyPlan(): RenderPlan {
  return {
    version: 1,
    id: 'empty',
    title: '空 plan',
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 1,
    preset: 'cinematic-realism',
    style: { tags: [], palette: [] },
    shots: [],
  }
}
