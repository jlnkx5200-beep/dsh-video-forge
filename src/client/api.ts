/**
 * 后端 HTTP 客户端（面板唯一出口）。
 *
 * 三条纪律：
 *  1. **严格响应结构校验**（P2-6）：每个响应都过一遍形状校验，形状不对就抛 ShapeError，
 *     绝不把 `undefined` 灌进 UI 状态（旧面板正是这么白屏的）。
 *  2. **错误分槽**（P0-3）：所有错误都带 `kind: 'connect' | 'submit' | 'config'`，
 *     由状态层放进对应槽位，成功一次就清空对应槽位，互不覆盖。
 *  3. **友好文案 + 技术细节可折叠**（P2-5）：给人看的是 title/hint，原始报文放 detail。
 */
export const API = '/api/dsh-video-forge'

export type ErrorKind = 'connect' | 'submit' | 'config'

export class ShapeError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(message)
    this.name = 'ShapeError'
    this.path = path
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly path: string
  readonly detail: string
  constructor(path: string, status: number, message: string, detail = '') {
    super(message)
    this.name = 'ApiError'
    this.path = path
    this.status = status
    this.detail = detail
  }
}

export interface ApiFailure {
  kind: ErrorKind
  title: string
  hint: string
  detail: string
}

/** 把任意异常翻译成「人能读懂」的三段式错误。 */
export function explainError(error: unknown, kind: ErrorKind): ApiFailure {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  if (error instanceof ShapeError) {
    return {
      kind,
      title: '后端返回的结构不认识',
      hint: 'Host 与面板版本可能不一致：重新构建并重载插件后再试（' + error.path + '）。',
      detail,
    }
  }
  if (error instanceof ApiError) {
    const map: Record<number, [string, string]> = {
      400: ['请求参数不合法', '检查分镜时长、参考图数量与首尾帧/多参考是否混传。'],
      401: ['鉴权失败', 'Bridge Token 或 Provider Key 不正确。'],
      403: ['只允许本机访问', '面板必须通过 127.0.0.1 访问 Host；远程访问请配置 bridgeToken。'],
      404: ['目标不存在', '作业可能已被清理，刷新一次列表。'],
      409: ['当前状态不允许该操作', '等作业结束或先取消再重试。'],
      413: ['请求体过大', '分镜太多或参考图太大，拆成两次生成。'],
    }
    const hit = map[error.status]
    if (hit !== undefined) return { kind, title: hit[0], hint: hit[1], detail }
    if (error.status >= 500) {
      return { kind, title: 'Host 内部错误', hint: '展开技术细节查看堆栈，必要时重启 DSH。', detail }
    }
    return { kind, title: error.message, hint: '后端拒绝了这次请求。', detail }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/abort/i.test(message)) {
    return { kind, title: '请求已取消', hint: '这次请求被主动中止（超时或点击取消）。', detail }
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return { kind: 'connect', title: '连不上本地 Host', hint: '确认 DSH 正在运行、插件已注入，然后点重试。', detail }
  }
  return { kind, title: '请求失败', hint: message, detail }
}

interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

function mergeSignals(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout after ' + timeoutMs + 'ms')), timeoutMs)
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

export async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 12000
  const merged = mergeSignals(timeoutMs, options.signal)
  try {
    const response = await fetch(API + path, {
      ...init,
      signal: merged.signal,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    })
    const text = await response.text()
    let payload: unknown = null
    if (text !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        throw new ShapeError(path, '响应不是合法 JSON：' + text.slice(0, 160))
      }
    }
    if (!response.ok) {
      const record = isRecord(payload) ? payload : {}
      const message = typeof record['error'] === 'string' ? record['error'] : 'HTTP ' + response.status
      throw new ApiError(path, response.status, message, text.slice(0, 2000))
    }
    return payload as T
  } finally {
    merged.dispose()
  }
}

// ── 形状校验原语（P2-6 的落地） ────────────────────────────────────────────
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function rec(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ShapeError(path, '期望对象，实际是 ' + typeof value)
  return value
}

export function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ShapeError(path, '期望数组，实际是 ' + typeof value)
  return value
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

// ── 领域类型 ──────────────────────────────────────────────────────────────
export interface ProviderHealth {
  provider: string
  status: 'ok' | 'degraded' | 'offline' | 'unknown'
  detail: string
  latencyMs?: number
  extra?: Record<string, unknown>
}

export type Magi2KeyState = 'missing_key' | 'invalid_key' | 'pending_quota' | 'ready' | 'configured_unprobed'

export interface StatusSnapshot {
  providers: ProviderHealth[]
  capabilities: Array<{ provider: string; label: string; kinds: string[]; models: string[]; mockable: boolean }>
  cache: { entries: number; bytes: number }
  paths: { root: string; out: string; cache: string; plans: string; tmp: string }
  clientId: string
  ffmpeg: { path?: string; exists?: boolean } | string
  comfyWorkflowDir: string
  comfyWorkflows: string[]
  keys: {
    ark: { present: boolean; hint: string; source: string }
    minimax: { present: boolean; hint: string; source: string }
    sand: { present: boolean; hint: string; source: string }
  }
  magi2: { state: Magi2KeyState; detail: string; baseUrl: string; keyHint: string; keySource: string; defaultDuration: number }
  userConfigPath: string
  fetchedAt: number
}

export interface RunEventLite {
  type: string
  taskId: string
  provider: string
  at: number
  message?: string
  progress?: number
}

export interface ArtifactLite {
  id: string
  kind: string
  fileKey: string
  path: string
  url: string
  bytes: number
  mime?: string
  width?: number
  height?: number
  durationSec?: number
  meta?: Record<string, unknown>
}

export interface JobResultLite {
  id: string
  provider: string
  ok: boolean
  cached: boolean
  seconds: number
  artifacts: ArtifactLite[]
  error?: string
  warnings: string[]
}

export interface JobLite {
  id: string
  planId: string
  title: string
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'pending_quota'
  startedAt: number
  endedAt?: number
  mock: boolean
  dryRun: boolean
  progress: { done: number; total: number; label: string }
  events: RunEventLite[]
  planPath?: string
  planJsonPath?: string
  error?: string
  issues: Array<{ level: string; shotId?: string; message?: string }>
  results: JobResultLite[]
  requestSnapshot?: Record<string, unknown>
  pendingQuota?: { taskId: string; provider: string; error: string }
  cancelable: boolean
  eventCount?: number
}

export interface PlanPreviewShot {
  id: string
  index: number
  from: number
  durationInFrames: number
  strategy: string
  caption?: string
  fileKeys: Record<string, string | undefined>
  previewUrl?: string
}

export interface PlanRow {
  planId: string
  title: string
  path: string
  shots: number
  frames: number
  modified: number
  preview?: PlanPreviewShot[]
}

export interface ProbeResult {
  state: Magi2KeyState
  detail: string
  url?: string
  status?: number
  at: number
}

// ── 端点 ──────────────────────────────────────────────────────────────────
export async function fetchStatus(signal?: AbortSignal): Promise<StatusSnapshot> {
  const raw = rec(await request<unknown>('/status', undefined, { signal, timeoutMs: 8000 }), '/status')
  const keys = rec(raw['keys'] ?? {}, '/status.keys')
  const ark = rec(keys['ark'] ?? {}, '/status.keys.ark')
  const minimax = rec(keys['minimax'] ?? {}, '/status.keys.minimax')
  const sand = rec(keys['sand'] ?? {}, '/status.keys.sand')
  const magi2 = rec(raw['magi2'] ?? {}, '/status.magi2')
  return {
    providers: arr(raw['providers'] ?? [], '/status.providers').map((item) => {
      const p = rec(item, '/status.providers[]')
      return {
        provider: str(p['provider']),
        status: (str(p['status'], 'unknown') as ProviderHealth['status']),
        detail: str(p['detail']),
        latencyMs: typeof p['latencyMs'] === 'number' ? p['latencyMs'] : undefined,
        extra: isRecord(p['extra']) ? p['extra'] : undefined,
      }
    }),
    capabilities: arr(raw['capabilities'] ?? [], '/status.capabilities').map((item) => {
      const c = rec(item, '/status.capabilities[]')
      return {
        provider: str(c['provider']),
        label: str(c['label']),
        kinds: strArray(c['kinds']),
        models: strArray(c['models']),
        mockable: bool(c['mockable']),
      }
    }),
    cache: { entries: num(rec(raw['cache'] ?? {}, '/status.cache')['entries']), bytes: num(rec(raw['cache'] ?? {}, '/status.cache')['bytes']) },
    paths: (() => {
      const p = rec(raw['paths'] ?? {}, '/status.paths')
      return { root: str(p['root']), out: str(p['out']), cache: str(p['cache']), plans: str(p['plans']), tmp: str(p['tmp']) }
    })(),
    clientId: str(raw['clientId']),
    ffmpeg: typeof raw['ffmpeg'] === 'string' ? str(raw['ffmpeg']) : rec(raw['ffmpeg'] ?? {}, '/status.ffmpeg'),
    comfyWorkflowDir: str(raw['comfyWorkflowDir']),
    comfyWorkflows: strArray(raw['comfyWorkflows']),
    keys: {
      ark: { present: bool(ark['present']), hint: str(ark['hint']), source: str(ark['source'], 'none') },
      minimax: { present: bool(minimax['present']), hint: str(minimax['hint']), source: str(minimax['source'], 'none') },
      sand: { present: bool(sand['present']), hint: str(sand['hint']), source: str(sand['source'], 'none') },
    },
    magi2: {
      state: str(magi2['state'], 'missing_key') as Magi2KeyState,
      detail: str(magi2['detail']),
      baseUrl: str(magi2['baseUrl']),
      keyHint: str(magi2['keyHint']),
      keySource: str(magi2['keySource'], 'none'),
      defaultDuration: num(magi2['defaultDuration'], 8),
    },
    userConfigPath: str(raw['userConfigPath']),
    // 后端没给 fetchedAt 时用本地时钟兜底：这是"这份数据什么时候拿到的"，不是内容
    fetchedAt: num(raw['fetchedAt'], Date.now()),
  }
}

export function parseJob(raw: unknown): JobLite {
  const job = rec(raw, '/jobs[]')
  const progress = rec(job['progress'] ?? {}, '/jobs[].progress')
  return {
    id: str(job['id']),
    planId: str(job['planId']),
    title: str(job['title']),
    status: (str(job['status'], 'running') as JobLite['status']),
    startedAt: num(job['startedAt']),
    endedAt: typeof job['endedAt'] === 'number' ? job['endedAt'] : undefined,
    mock: bool(job['mock']),
    dryRun: bool(job['dryRun']),
    progress: { done: num(progress['done']), total: num(progress['total']), label: str(progress['label']) },
    events: arr(job['events'] ?? [], '/jobs[].events').map((item) => {
      const e = rec(item, '/jobs[].events[]')
      return {
        type: str(e['type']),
        taskId: str(e['taskId']),
        provider: str(e['provider']),
        at: num(e['at']),
        message: typeof e['message'] === 'string' ? e['message'] : undefined,
        progress: typeof e['progress'] === 'number' ? e['progress'] : undefined,
      }
    }),
    planPath: typeof job['planPath'] === 'string' ? job['planPath'] : undefined,
    planJsonPath: typeof job['planJsonPath'] === 'string' ? job['planJsonPath'] : undefined,
    error: typeof job['error'] === 'string' ? job['error'] : undefined,
    issues: arr(job['issues'] ?? [], '/jobs[].issues').map((item) => {
      const i = rec(item, '/jobs[].issues[]')
      return { level: str(i['level']), shotId: typeof i['shotId'] === 'string' ? i['shotId'] : undefined, message: typeof i['message'] === 'string' ? i['message'] : undefined }
    }),
    results: arr(job['results'] ?? [], '/jobs[].results').map((item) => {
      const r = rec(item, '/jobs[].results[]')
      return {
        id: str(r['id']),
        provider: str(r['provider']),
        ok: bool(r['ok']),
        cached: bool(r['cached']),
        seconds: num(r['seconds']),
        artifacts: arr(r['artifacts'] ?? [], '/jobs[].results[].artifacts').map((a) => {
          const art = rec(a, '/jobs[].results[].artifacts[]')
          return {
            id: str(art['id']),
            kind: str(art['kind']),
            fileKey: str(art['fileKey']),
            path: str(art['path']),
            url: str(art['url']),
            bytes: num(art['bytes']),
            mime: typeof art['mime'] === 'string' ? art['mime'] : undefined,
            width: typeof art['width'] === 'number' ? art['width'] : undefined,
            height: typeof art['height'] === 'number' ? art['height'] : undefined,
            durationSec: typeof art['durationSec'] === 'number' ? art['durationSec'] : undefined,
            meta: isRecord(art['meta']) ? art['meta'] : undefined,
          }
        }),
        error: typeof r['error'] === 'string' ? r['error'] : undefined,
        warnings: strArray(r['warnings']),
      }
    }),
    requestSnapshot: isRecord(job['requestSnapshot']) ? job['requestSnapshot'] : undefined,
    pendingQuota: isRecord(job['pendingQuota'])
      ? { taskId: str(job['pendingQuota']['taskId']), provider: str(job['pendingQuota']['provider']), error: str(job['pendingQuota']['error']) }
      : undefined,
    cancelable: bool(job['cancelable'], str(job['status'], 'running') === 'running'),
    eventCount: typeof job['eventCount'] === 'number' ? job['eventCount'] : undefined,
  }
}

export async function fetchJobs(limit: number, signal?: AbortSignal): Promise<JobLite[]> {
  const raw = rec(await request<unknown>('/jobs?limit=' + limit, undefined, { signal, timeoutMs: 8000 }), '/jobs')
  return arr(raw['jobs'] ?? [], '/jobs.jobs').map(parseJob)
}

export interface JobDetail {
  job: JobLite
  events: RunEventLite[]
  cursor: number
}

/** 增量拉取（P1-1）：只取 since 之后的新事件，游标由调用方持有。 */
export async function fetchJob(id: string, since: number, signal?: AbortSignal): Promise<JobDetail> {
  const raw = rec(await request<unknown>('/jobs?id=' + encodeURIComponent(id) + '&since=' + since, undefined, { signal, timeoutMs: 8000 }), '/jobs?id')
  const events = arr(raw['events'] ?? [], '/jobs.events').map((item) => {
    const e = rec(item, '/jobs.events[]')
    return {
      type: str(e['type']),
      taskId: str(e['taskId']),
      provider: str(e['provider']),
      at: num(e['at']),
      message: typeof e['message'] === 'string' ? e['message'] : undefined,
      progress: typeof e['progress'] === 'number' ? e['progress'] : undefined,
    }
  })
  return { job: parseJob(raw['job']), events, cursor: since + events.length }
}

export async function fetchPlans(signal?: AbortSignal): Promise<PlanRow[]> {
  const raw = rec(await request<unknown>('/plans', undefined, { signal, timeoutMs: 8000 }), '/plans')
  return arr(raw['plans'] ?? [], '/plans.plans').map((item) => {
    const p = rec(item, '/plans.plans[]')
    return {
      planId: str(p['planId']),
      title: str(p['title']),
      path: str(p['path']),
      shots: num(p['shots']),
      frames: num(p['frames']),
      modified: num(p['modified']),
      preview: Array.isArray(p['preview']) ? p['preview'].map(parsePreviewShot) : undefined,
    }
  })
}

function parsePreviewShot(raw: unknown): PlanPreviewShot {
  const shot = rec(raw, '/preview[]')
  const fileKeys = rec(shot['fileKeys'] ?? {}, '/preview[].fileKeys')
  const keys: Record<string, string | undefined> = {}
  for (const key of ['still', 'plate', 'depth', 'matte', 'video']) {
    const value = fileKeys[key]
    if (typeof value === 'string' && value !== '') keys[key] = value
  }
  return {
    id: str(shot['id']),
    index: num(shot['index']),
    from: num(shot['from']),
    durationInFrames: num(shot['durationInFrames']),
    strategy: str(shot['strategy']),
    caption: typeof shot['caption'] === 'string' ? shot['caption'] : undefined,
    fileKeys: keys,
    previewUrl: typeof shot['previewUrl'] === 'string' ? shot['previewUrl'] : undefined,
  }
}

export async function fetchPlan(planId: string, signal?: AbortSignal): Promise<{ plan: Record<string, unknown>; preview: PlanPreviewShot[]; issues: Array<{ level: string; message?: string }> }> {
  const raw = rec(await request<unknown>('/plan/' + encodeURIComponent(planId), undefined, { signal, timeoutMs: 10000 }), '/plan/:id')
  return {
    plan: rec(raw['plan'], '/plan/:id.plan'),
    preview: arr(raw['preview'] ?? [], '/plan/:id.preview').map(parsePreviewShot),
    issues: arr(raw['issues'] ?? [], '/plan/:id.issues').map((item) => {
      const i = rec(item, '/plan/:id.issues[]')
      return { level: str(i['level']), message: typeof i['message'] === 'string' ? i['message'] : undefined }
    }),
  }
}

export interface ProduceAccepted {
  jobId: string
  job: JobLite
}

/** POST /produce：202 就把 jobId 交回来（P1-9），前端不再 800ms 盲猜。 */
export async function produce(body: Record<string, unknown>, signal?: AbortSignal): Promise<ProduceAccepted> {
  const raw = rec(await request<unknown>('/produce', { method: 'POST', body: JSON.stringify(body) }, { signal, timeoutMs: 20000 }), '/produce')
  const jobId = str(raw['jobId'])
  if (jobId === '') throw new ShapeError('/produce', '响应里没有 jobId，无法锁定作业')
  return { jobId, job: parseJob(raw['job'] ?? { id: jobId, status: 'running' }) }
}

export async function cancelJob(id: string, signal?: AbortSignal): Promise<JobLite> {
  const raw = rec(await request<unknown>('/jobs/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }, { signal, timeoutMs: 10000 }), '/jobs/:id/cancel')
  return parseJob(raw['job'])
}

export async function replayJob(id: string, signal?: AbortSignal): Promise<ProduceAccepted> {
  const raw = rec(await request<unknown>('/jobs/' + encodeURIComponent(id) + '/replay', { method: 'POST' }, { signal, timeoutMs: 20000 }), '/jobs/:id/replay')
  const jobId = str(raw['jobId'])
  if (jobId === '') throw new ShapeError('/jobs/:id/replay', '响应里没有 jobId')
  return { jobId, job: parseJob(raw['job'] ?? { id: jobId, status: 'running' }) }
}

export async function probeMagi2(signal?: AbortSignal): Promise<{ ok: boolean; state: Magi2KeyState; detail: string; hint: string }> {
  const raw = rec(await request<unknown>('/magi2/probe', { method: 'POST' }, { signal, timeoutMs: 15000 }), '/magi2/probe')
  const probe = rec(raw['probe'] ?? {}, '/magi2/probe.probe')
  return {
    ok: bool(raw['ok']),
    state: str(probe['state'], 'configured_unprobed') as Magi2KeyState,
    detail: str(probe['detail']),
    hint: str(raw['hint'], str(probe['detail'])),
  }
}

export async function saveConfig(patch: Record<string, unknown>, signal?: AbortSignal): Promise<{ written: string[]; rejected: string[]; hints: Record<string, string> }> {
  const raw = rec(await request<unknown>('/config', { method: 'POST', body: JSON.stringify(patch) }, { signal, timeoutMs: 10000 }), '/config')
  const hints = rec(raw['hints'] ?? {}, '/config.hints')
  return {
    written: strArray(raw['written']),
    rejected: strArray(raw['rejected']),
    hints: { ark: str(hints['ark']), minimax: str(hints['minimax']), sand: str(hints['sand']) },
  }
}

/** 产物直链（GET /file/<fileKey>）。 */
export function fileUrl(fileKey: string): string {
  return API + '/file/' + fileKey.split('/').map(encodeURIComponent).join('/')
}
