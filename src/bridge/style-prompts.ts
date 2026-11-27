/**
 * 风格提示词编译表（host 侧）—— 上游生图的"审美锚点"。
 *
 * 为什么要单独一张表：
 *   下游 Three.js 渲染的观感（曝光/雾/粒子/视差）必须和上游 Seedream / MiniMax 出的图
 *   是同一个审美方向，否则"3D 调得很文艺、原图却很塑料"，怎么渲都不对。
 *   这里把六套预设的 `promptModifiers`（anchors + negative）落成 host 可用的数据，
 *   与 `remotion/src/presets/library.tsx` 里的同名预设一一对应（id 必须一致）。
 *
 * 纪律（docs/visual-quality-standard.md）：
 *   * 每个预设都必须给出 anchors 与 negative，不允许空表；
 *   * negative 必须压掉"涂抹感 / 过度锐化 / 噪点 / 水印 / 文字 / 低质纹理"这几类毁画质的东西；
 *   * 提示词只做"风格锚定"，不写具体镜头内容 —— 内容来自分镜，不许被模板句覆盖。
 */

export interface StylePromptProfile {
  id: string
  label: string
  /** 正向锚点词（追加在分镜内容之后） */
  anchors: string[]
  /** 负向去噪词（Seedream 用 prompt 后缀；MiniMax 也拼进去） */
  negative: string[]
  /** 这个风格推荐的运镜（写入 plan 的 cameraHints 语义，仅提示） */
  cameraHints: string[]
}

const COMMON_NEGATIVE = ['涂抹感', '过度锐化', '噪点', '水印', '文字', 'logo', '低质纹理', '扁平构图']

function profile(
  id: string, label: string, cameraHints: string[], anchors: string[], negative: string[],
): StylePromptProfile {
  return { id, label, cameraHints, anchors, negative: [...COMMON_NEGATIVE, ...negative] }
}

export const STYLE_PROMPTS: Record<string, StylePromptProfile> = {
  'cinematic-realism': profile('cinematic-realism', '电影写实', ['dolly-in', 'crane-up', 'pan', 'static'], [
    '电影级写实摄影', '柔和自然光与体积光', '前景中景背景三层景深', '35mm 胶片质感',
    '低饱和高级灰调', '细腻空气感与薄雾', '清晰的主体轮廓与材质细节',
  ], ['畸变肢体']),
  'editorial-minimal': profile('editorial-minimal', '极简杂志', ['pan', 'dolly-out', 'static'], [
    '极简主义构图', '大面积留白', '高级灰调', '暖白柔光', '克制的材质细节', '干净背景',
  ], ['杂乱背景', '密集纹理', '高饱和', '过度装饰']),
  'anime-atmospheric': profile('anime-atmospheric', '日系通透', ['pan', 'dolly-in', 'crane-up'], [
    '新海诚风格', '清澈通透的夏日天空', '柔和漫反射光晕', '云隙光', '明显的前后景层次', '轻盈飘浮的光斑',
  ], ['脏灰', '厚涂', '低分辨率']),
  'cyber-neon': profile('cyber-neon', '赛博霓虹', ['orbit', 'dolly-in', 'handheld'], [
    '赛博朋克', '冷暖双色边缘光', '霓虹反射与湿地面', '体积雾', '高科技几何阵列', '硬朗材质与金属细节',
  ], ['过曝溢出', '脏灰', '杂乱主体']),
  'oriental-ink': profile('oriental-ink', '东方意境', ['pan', 'static', 'dolly-out'], [
    '东方水墨意境', '大量留白', '远近层次空气透视', '墨色浓淡与皴擦笔触', '低饱和雅致色阶', '云雾缭绕',
  ], ['高饱和', '西方油画', '塑料质感']),
  'video-first': profile('video-first', '视频融合', ['static', 'dolly-in', 'pan'], [
    '实拍级质感', '稳定的镜头运动', '自然的景深过渡', '柔和边缘与光影融合', '真实材质反射',
  ], ['抖动', '闪烁', '贴纸感硬边', '低分辨率']),
}

export const DEFAULT_STYLE_ID = 'cinematic-realism'

export function styleProfileOf(id: string | undefined): StylePromptProfile {
  if (id !== undefined && STYLE_PROMPTS[id] !== undefined) return STYLE_PROMPTS[id]!
  return STYLE_PROMPTS[DEFAULT_STYLE_ID]!
}

export interface ComposePromptOptions {
  /** 分镜自带的内容描述（主提示词） */
  base: string
  /** 预设 id（cinematic-realism / ...） */
  presetId?: string
  /** 分镜自己的风格标签（会追加） */
  styleTags?: string[]
  /** 镜别（wide / medium / close / macro），用于补构图层建议 */
  shotSize?: string
  /** 是否附加负向词（默认 true；某些模型不接受则关掉） */
  withNegative?: boolean
  /** 额外追加（用户覆写） */
  extraAnchors?: string[]
}

const SHOT_SIZE_HINT: Record<string, string> = {
  wide: '大远景构图，主体占画面比例小，强调空间纵深与空气透视',
  medium: '中景构图，主体居中偏下，前后景层次清晰',
  close: '近景特写构图，浅景深，背景柔和虚化',
  macro: '微距特写构图，极浅景深，材质纹理清晰',
}

/**
 * 把「分镜内容 + 风格锚点 + 构图建议 + 负向词」编译成一条可用的上游提示词。
 *
 * 顺序很重要：内容在前、风格在中、构图在后、负向词在末尾 —— 这样模型对内容权重最高，
 * 不会被一堆风格词带跑偏。
 */
export function composeStyledPrompt(options: ComposePromptOptions): string {
  const profile = styleProfileOf(options.presetId)
  const parts: string[] = []
  const base = options.base.trim()
  parts.push(base !== '' ? base : '一个干净的电影感空镜')

  for (const anchor of profile.anchors) {
    if (!parts.includes(anchor)) parts.push(anchor)
  }
  for (const tag of options.styleTags ?? []) {
    const t = tag.trim()
    if (t !== '' && !parts.includes(t)) parts.push(t)
  }
  const sizeHint = options.shotSize === undefined ? undefined : SHOT_SIZE_HINT[options.shotSize]
  if (sizeHint !== undefined) parts.push(sizeHint)
  for (const extra of options.extraAnchors ?? []) {
    const t = extra.trim()
    if (t !== '' && !parts.includes(t)) parts.push(t)
  }
  if (options.withNegative !== false && profile.negative.length > 0) {
    parts.push('避免：' + profile.negative.join('、'))
  }
  return parts.join('。')
}

/** 给 UI / 文档用：列出所有可用风格。 */
export function listStylePrompts(): Array<{ id: string; label: string; anchors: number; negative: number }> {
  return Object.values(STYLE_PROMPTS).map(p => ({
    id: p.id, label: p.label, anchors: p.anchors.length, negative: p.negative.length,
  }))
}
