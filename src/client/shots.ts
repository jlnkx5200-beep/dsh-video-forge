/**
 * 结构化镜头编辑 ⇄ Markdown 分镜表的双向同步（P1-3）。
 *
 * 面板给两条路：表格里直接点着改（结构化），或者贴/改一段 Markdown 分镜表（人写最快）。
 * 两边都落到同一个 `ShotRow[]`，再由 `toShotPayload()` 变成 /produce 的 shots 数组 ——
 * 所以不存在"表单和 Markdown 说的不是同一件事"这种烂状态。
 */

export interface ShotRow {
  id: string
  /** 展示用时间段："0-4s" */
  time: string
  durationSec: number
  shot: string
  move: string
  transition: string
  prompt: string
  strategy: string
  /** MAGI-2 专用：显式首尾帧（走 Ark 兼容端点） */
  firstFrame?: string
  lastFrame?: string
  referenceImages?: string[]
  generateAudio?: boolean
  timelineCues?: Array<{ atSec: number; prompt: string }>
}

export const MOVES = ['dolly-in', 'dolly-out', 'orbit', 'pan', 'crane-up', 'handheld', 'static'] as const
export const TRANSITIONS = ['crossfade', 'radial-blur', 'luma-wipe', 'noise-dissolve', 'push'] as const
export const STRATEGIES = [
  'seedream-static', 'still-3d', 'comfy-pipeline',
  'minimax-direct', 'minimax-2k-repaint', 'magi2-direct', 'magi2-i2v',
] as const

/** "0-4s" / "4s" / "0–4" 都认；读不出来给 4 秒（后端也会夹紧）。 */
export function parseDuration(text: string): number {
  const matches = text.match(/\d+(?:\.\d+)?/g)
  if (matches === null || matches.length === 0) return 4
  const last = Number(matches[matches.length - 1])
  if (!Number.isFinite(last) || last <= 0) return 4
  return Math.max(1, Math.min(30, last))
}

function pickKnown(value: string, allowed: readonly string[], fallback: string): string {
  const lower = value.trim().toLowerCase()
  const hit = allowed.find(item => item === lower)
  if (hit !== undefined) return hit
  const fuzzy = allowed.find(item => lower.includes(item.split('-')[0] ?? ''))
  return fuzzy ?? fallback
}

function cells(line: string): string[] {
  const trimmed = line.trim()
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const tail = body.endsWith('|') ? body.slice(0, -1) : body
  return tail.split('|').map(cell => cell.trim())
}

/** 解析 Markdown 分镜表；兼容 video-shotcraft 的 6 列表头。 */
export function parseMarkdownShots(markdown: string): ShotRow[] {
  const rows: ShotRow[] = []
  const lines = markdown.split(/\r?\n/).filter(line => line.includes('|'))
  let header: string[] | null = null
  for (const line of lines) {
    const cols = cells(line)
    if (cols.length < 2) continue
    if (cols.every(col => /^:?-{2,}:?$/.test(col))) continue
    if (header === null) {
      header = cols.map(col => col.toLowerCase())
      continue
    }
    const get = (names: string[]): string => {
      for (const name of names) {
        const index = header!.findIndex(col => col.includes(name))
        if (index >= 0) return cols[index] ?? ''
      }
      return ''
    }
    const time = get(['时间', 'time', '时长', 'duration'])
    const shot = get(['镜头', 'shot', '景别'])
    const move = get(['关键动效', 'move', '运镜', '动效'])
    const prompt = get(['提示词', 'prompt', '描述', 'description'])
    if (time === '' && shot === '' && prompt === '') continue
    rows.push({
      id: 'shot-' + (rows.length + 1),
      time: time === '' ? '0-' + parseDuration(time) + 's' : time,
      durationSec: parseDuration(time),
      shot: shot === '' ? 'medium' : shot,
      move: pickKnown(move, MOVES, 'dolly-in'),
      transition: pickKnown(get(['转场', 'transition']), TRANSITIONS, 'crossfade'),
      prompt,
      strategy: pickKnown(get(['策略', 'strategy']), STRATEGIES, 'seedream-static'),
    })
  }
  return rows
}

/** 反向：结构化行 → Markdown 表（用户随时可以复制出去存档）。 */
export function toMarkdown(rows: ShotRow[]): string {
  const head = '| # | 时间 | 镜头 | 关键动效 | 转场 | 策略 | 提示词 |'
  const sep = '| --- | --- | --- | --- | --- | --- | --- |'
  const body = rows.map((row, index) => '| ' + [String(index + 1), row.time, row.shot, row.move, row.transition, row.strategy, row.prompt].join(' | ') + ' |')
  return [head, sep, ...body].join('\n')
}

/** 空行模板：用户点"加一镜"时插入。 */
export function blankShot(index: number): ShotRow {
  return {
    id: 'shot-' + (index + 1),
    time: '0-4s',
    durationSec: 4,
    shot: 'medium',
    move: 'dolly-in',
    transition: 'crossfade',
    prompt: '',
    strategy: 'seedream-static',
  }
}

/** 结构化行 → /produce 的 shots 数组；空值一律不写（后端按缺省处理）。 */
export function toShotPayload(rows: ShotRow[]): Array<Record<string, unknown>> {
  return rows.map((row, index) => {
    const shot: Record<string, unknown> = {
      id: row.id === '' ? 'shot-' + (index + 1) : row.id,
      shot: row.shot,
      durationSec: Math.max(1, Math.min(30, row.durationSec)),
      prompt: row.prompt,
      move: row.move,
      transition: row.transition,
      strategy: row.strategy,
    }
    if (row.firstFrame !== undefined && row.firstFrame !== '') shot['firstFrame'] = row.firstFrame
    if (row.lastFrame !== undefined && row.lastFrame !== '') shot['lastFrame'] = row.lastFrame
    if (row.referenceImages !== undefined && row.referenceImages.length > 0) shot['referenceImages'] = row.referenceImages.filter(item => item !== '')
    if (typeof row.generateAudio === 'boolean') shot['generateAudio'] = row.generateAudio
    if (row.timelineCues !== undefined && row.timelineCues.length > 0) shot['timelineCues'] = row.timelineCues
    return shot
  })
}

/** 校验：把明显会 400 的组合提前挑出来（提交按钮旁边显示）。 */
export function validateShots(rows: ShotRow[]): Array<{ level: 'error' | 'warn'; message: string }> {
  const issues: Array<{ level: 'error' | 'warn'; message: string }> = []
  if (rows.length === 0) issues.push({ level: 'error', message: '至少需要一个镜头。' })
  rows.forEach((row, index) => {
    const label = '第 ' + (index + 1) + ' 镜'
    if (row.prompt.trim() === '') issues.push({ level: 'error', message: label + ' 缺提示词。' })
    const hasFrames = (row.firstFrame ?? '') !== '' || (row.lastFrame ?? '') !== ''
    const hasRefs = (row.referenceImages ?? []).length > 0
    if (hasFrames && hasRefs) issues.push({ level: 'error', message: label + ' 同时给了首尾帧和参考图：首尾帧走 Ark 兼容端点，多参考走 Native，不能混传。' })
    if (row.strategy.startsWith('magi2') && row.durationSec > 30) issues.push({ level: 'error', message: label + ' 时长 ' + row.durationSec + 's 超过 MAGI-2 上限 30s。' })
    if (!row.strategy.startsWith('magi2') && row.durationSec > 15) issues.push({ level: 'error', message: label + ' 时长 ' + row.durationSec + 's 超过 H3 单镜上限 15s，请拆分或改用 MAGI-2。' })
  })
  return issues
}
