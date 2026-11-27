/**
 * 面板状态机（纯函数，无 React、无 fetch）—— P2-8 的测试入口。
 *
 * 这里集中了三处过去最容易烂掉的地方：
 *  · **P0-2 断连态**：状态快照带 fetchedAt；连续失败 ≥2 次或快照超过 15s 未更新即 stale，
 *    stale 时整块 UI 灰掉并禁用提交，绝不让用户对着旧数据点"生成"。
 *  · **P0-3 错误分槽**：connect / submit / config 三个槽位互不覆盖，成功一次只清对应槽。
 *  · **P0-1 快照重跑**：`formFromSnapshot()` 只从 job.requestSnapshot 取值，
 *    保证「按原参数重跑」真的按原参数，而不是按当前表单。
 */
import type { ApiFailure, ErrorKind, JobLite, ProduceAccepted, RunEventLite, StatusSnapshot } from './api.js'
import { DEFAULT_STYLE_ID } from '../bridge/style-prompts.js'

export const STALE_AFTER_MS = 15_000
export const STALE_FAILURES = 2

export interface FormState {
  title: string
  markdownTable: string
  preset: string
  qualityMode: 'production' | 'draft'
  strategy: string
  minimaxModel: string
  minimaxResolution: string
  magi2Model: string
  magi2Duration: number
  generateAudio: boolean
  fps: number
  width: number
  height: number
  enablePlate: boolean
  mock: boolean
  dryRun: boolean
  useCache: boolean
}

export interface JobStream {
  job: JobLite
  events: RunEventLite[]
  cursor: number
}

export interface PanelState {
  conn: {
    status?: StatusSnapshot
    fetchedAt: number
    failures: number
    stale: boolean
    lastError?: ApiFailure
  }
  errors: Partial<Record<ErrorKind, ApiFailure>>
  jobs: JobLite[]
  /** P1-9：提交后立刻锁定的作业 id（来自 202，不靠轮询猜） */
  activeJobId?: string
  streams: Record<string, JobStream>
  plansLoadedAt: number
  notice?: { tone: 'ok' | 'warn' | 'danger' | 'info'; text: string }
  form: FormState
}

export function initialForm(): FormState {
  return {
    title: 'Video Forge Composition',
    markdownTable: [
      '| # | 时间 | 镜头 | 关键动效 |',
      '| --- | --- | --- | --- |',
      '| 1 | 0-4s | 全景建立：雾中山脊显形 | dolly-in |',
      '| 2 | 4-9s | 中景：主体在光里转身 | handheld |',
      '| 3 | 9-12s | 收尾：拉远露出空间阵列 | dolly-out |',
    ].join('\n'),
    preset: DEFAULT_STYLE_ID,
    qualityMode: 'production',
    strategy: 'seedream-static',
    minimaxModel: 'MiniMax-H3',
    minimaxResolution: '768P',
    magi2Model: 'MAGI-2',
    magi2Duration: 8,
    generateAudio: true,
    fps: 30,
    width: 1920,
    height: 1080,
    enablePlate: false,
    mock: true,
    dryRun: false,
    useCache: true,
  }
}

export function initialState(): PanelState {
  return {
    conn: { fetchedAt: 0, failures: 0, stale: true },
    errors: {},
    jobs: [],
    streams: {},
    plansLoadedAt: 0,
    form: initialForm(),
  }
}

/** 快照是否已过期（时间维度）。 */
export function isStale(state: PanelState, now: number): boolean {
  if (state.conn.stale) return true
  if (state.conn.fetchedAt <= 0) return true
  if (state.conn.failures >= STALE_FAILURES) return true
  return now - state.conn.fetchedAt > STALE_AFTER_MS
}

/** 提交按钮是否可用：stale 时一律禁用（P0-2）。 */
export function canSubmit(state: PanelState, now: number): boolean {
  return !isStale(state, now)
}

export function onStatusOk(state: PanelState, status: StatusSnapshot, now: number): PanelState {
  const errors = { ...state.errors }
  delete errors.connect
  return {
    ...state,
    conn: { status, fetchedAt: status.fetchedAt > 0 ? status.fetchedAt : now, failures: 0, stale: false, lastError: undefined },
    errors,
  }
}

export function onConnectFail(state: PanelState, failure: ApiFailure, now: number): PanelState {
  const failures = state.conn.failures + 1
  const stale = failures >= STALE_FAILURES || state.conn.fetchedAt <= 0 || now - state.conn.fetchedAt > STALE_AFTER_MS
  return {
    ...state,
    conn: { ...state.conn, failures, stale, lastError: failure },
    errors: { ...state.errors, connect: failure },
  }
}

/** P0-3：成功后只清对应槽位，其它槽位的错误保留（用户还需要看到）。 */
export function clearError(state: PanelState, kind: ErrorKind): PanelState {
  if (state.errors[kind] === undefined) return state
  const errors = { ...state.errors }
  delete errors[kind]
  return { ...state, errors }
}

export function setError(state: PanelState, kind: ErrorKind, failure: ApiFailure): PanelState {
  return { ...state, errors: { ...state.errors, [kind]: failure } }
}

export function setNotice(state: PanelState, tone: 'ok' | 'warn' | 'danger' | 'info', text: string): PanelState {
  return { ...state, notice: { tone, text } }
}

export function clearNotice(state: PanelState): PanelState {
  if (state.notice === undefined) return state
  return { ...state, notice: undefined }
}

export function mergeJobs(state: PanelState, jobs: JobLite[]): PanelState {
  const byId = new Map<string, JobLite>()
  for (const job of jobs) byId.set(job.id, job)
  // 保留列表里尚未返回的旧作业（limit 截断时不要让卡片闪没）
  for (const job of state.jobs) if (!byId.has(job.id)) byId.set(job.id, job)
  const merged = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
  const streams: Record<string, JobStream> = { ...state.streams }
  for (const job of jobs) {
    const previous = streams[job.id]
    if (previous === undefined) continue
    streams[job.id] = { ...previous, job }
  }
  return { ...state, jobs: merged, streams }
}

/** 202 到达：立刻锁定 jobId 并把作业插到列表最前（P1-9）。 */
export function onProduceAccepted(state: PanelState, accepted: ProduceAccepted): PanelState {
  const streams = { ...state.streams }
  streams[accepted.jobId] = { job: accepted.job, events: accepted.job.events, cursor: accepted.job.events.length }
  const jobs = [accepted.job, ...state.jobs.filter(job => job.id !== accepted.jobId)]
  return {
    ...state,
    activeJobId: accepted.jobId,
    jobs,
    streams,
    errors: omit(state.errors, 'submit'),
  }
}

/** 增量事件合并（P1-1）：按 cursor 追加，去重靠 cursor 单调前进。 */
export function appendJobEvents(state: PanelState, id: string, next: JobLite, events: RunEventLite[], cursor: number): PanelState {
  const previous = state.streams[id]
  const merged = previous === undefined ? events.slice() : previous.events.concat(events)
  const capped = merged.length > 400 ? merged.slice(merged.length - 400) : merged
  const streams: Record<string, JobStream> = { ...state.streams, [id]: { job: next, events: capped, cursor } }
  const jobs = state.jobs.some(job => job.id === id)
    ? state.jobs.map(job => (job.id === id ? next : job))
    : [next, ...state.jobs]
  return { ...state, streams, jobs }
}

function omit<T extends object, K extends keyof T>(source: T, key: K): T {
  const copy = { ...source }
  delete copy[key]
  return copy
}

export interface RerunForm {
  form: Partial<FormState>
  missing: string[]
  snapshot: Record<string, unknown>
}

/**
 * P0-1 的核心：把 job.requestSnapshot 映射回表单字段。
 * 缺失字段列进 missing，绝不静默替换成当前表单值。
 */
export function formFromSnapshot(snapshot: Record<string, unknown> | undefined): RerunForm {
  if (snapshot === undefined) return { form: {}, missing: ['*'], snapshot: {} }
  const missing: string[] = []
  const form: Partial<FormState> = {}

  const storyboard = snapshot['storyboard']
  if (typeof storyboard === 'object' && storyboard !== null) {
    const board = storyboard as Record<string, unknown>
    if (typeof board['title'] === 'string') form.title = board['title']
    if (typeof board['fps'] === 'number') form.fps = board['fps']
    if (typeof board['width'] === 'number') form.width = board['width']
    if (typeof board['height'] === 'number') form.height = board['height']
    if (typeof board['preset'] === 'string') form.preset = board['preset']
  } else {
    missing.push('storyboard')
  }

  const options = snapshot['options']
  if (typeof options === 'object' && options !== null) {
    const opts = options as Record<string, unknown>
    if (typeof opts['defaultStrategy'] === 'string') form.strategy = opts['defaultStrategy']
    if (typeof opts['minimaxModel'] === 'string') form.minimaxModel = opts['minimaxModel']
    if (typeof opts['minimaxResolution'] === 'string') form.minimaxResolution = opts['minimaxResolution']
    if (typeof opts['magi2Model'] === 'string') form.magi2Model = opts['magi2Model']
    if (typeof opts['magi2Duration'] === 'number') form.magi2Duration = opts['magi2Duration']
    if (typeof opts['generateAudio'] === 'boolean') form.generateAudio = opts['generateAudio']
    if (opts['qualityMode'] === 'draft' || opts['qualityMode'] === 'production') form.qualityMode = opts['qualityMode']
    if (typeof opts['mock'] === 'boolean') form.mock = opts['mock']
    if (typeof opts['dryRun'] === 'boolean') form.dryRun = opts['dryRun']
    // useCache 是显式勾选框，绝不硬编码：快照里没记就进 missing，由 UI 提示用户自己选
    if (typeof opts['useCache'] === 'boolean') form.useCache = opts['useCache']
    else missing.push('useCache')
    if (typeof opts['enablePlate'] === 'boolean') form.enablePlate = opts['enablePlate']
  } else {
    missing.push('options')
  }

  for (const key of ['defaultStrategy', 'minimaxModel', 'magi2Model', 'qualityMode'] as const) {
    if (form[key as keyof FormState] === undefined && !missing.includes(key)) missing.push(key)
  }
  return { form, missing, snapshot }
}

/** 表单 → /produce 请求体（前端唯一构造点，便于测试参数保真）。 */
export function buildProduceBody(form: FormState, shots?: Array<Record<string, unknown>>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: form.title,
    preset: form.preset,
    qualityMode: form.qualityMode,
    defaultStrategy: form.strategy,
    minimaxModel: form.minimaxModel,
    minimaxResolution: form.minimaxResolution,
    magi2Model: form.magi2Model,
    magi2Duration: form.magi2Duration,
    generateAudio: form.generateAudio,
    fps: form.fps,
    width: form.width,
    height: form.height,
    enablePlate: form.enablePlate,
    mock: form.mock,
    dryRun: form.dryRun,
    useCache: form.useCache,
    writePlan: true,
  }
  if (Array.isArray(shots)) body['shots'] = shots
  else body['markdownTable'] = form.markdownTable
  return body
}
