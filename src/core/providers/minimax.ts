/**
 * MiniMax H3 Provider —— 官方 v2 视频生成 API（T2V / I2V 首帧、尾帧 / R2V）。
 *
 * 官方参数直通：content[] 由调用方拼好也可以（params.content），否则按 prompt/首帧/尾帧/参考图自动组装。
 * 轮询：指数退避（3s → ×1.6 → 上限 15s），失败按 HTTP 语义判定可重试性。
 *
 * 基址双站：国际站 https://api.minimax.io、国内站 https://api.minimaxi.com。
 * 同一把 Key 只能在其中一站生效（实测国内 Key 打国际站返回 401 authorized_error/invalid api key (2049)），
 * 故 health() 会做一次免计费的列表查询，401 时提示换站。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type {
  MediaProvider, ProviderCapability, ProviderHealth, RunContext, TaskRequest, TaskResult,
} from './types.js'
import { ForgeError } from './types.js'
import { isAborted, sleep } from '../http.js'

/** 超时与外部取消合并：任一触发即中止（AbortSignal.any 不可用时退化为外部信号，超时由各请求自行兜底）。 */
function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  return typeof anyFn === 'function' ? anyFn([signal, timeout]) : signal
}

export interface MinimaxModelInfo {
  id: string
  label: string
  note: string
}

export const MINIMAX_MODELS: MinimaxModelInfo[] = [
  { id: 'MiniMax-H3', label: 'H3 标准', note: '768P/2K，4–15s，t2v/i2v/r2v' },
  { id: 'MiniMax-H3-Highspeed', label: 'H3 高速', note: '480P/768P，含参考视频+音频' },
  { id: 'MiniMax-H3-Lite', label: 'H3 轻量', note: '480P/768P，便宜' },
  { id: 'MiniMax-H3-Max', label: 'H3 Max', note: '480P/768P，5–15s，质量优先' },
]

export const MINIMAX_RESOLUTIONS = ['480P', '768P', '2K']
export const MINIMAX_RATIOS = ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

const MAX_IMAGE_BYTES = 30 * 1024 * 1024

/** 本地图片 → data URL。远程 URL 原样返回。 */
function toDataUrl(pathOrUrl: string, role: string): string {
  if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith('data:')) return pathOrUrl
  if (!existsSync(pathOrUrl)) throw new ForgeError(role + ' 指定的文件不存在：' + pathOrUrl, false)
  const st = statSync(pathOrUrl)
  if (st.size > MAX_IMAGE_BYTES) throw new ForgeError(role + ' 超过 30MB 上限（' + Math.round(st.size / 1048576) + 'MB）', false)
  const ext = extname(pathOrUrl).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
  return 'data:' + mime + ';base64,' + readFileSync(pathOrUrl).toString('base64')
}

interface PollOutcome {
  status: string
  url?: string
  error?: { code?: string; message?: string }
  raw: Record<string, unknown>
}

export class MinimaxProvider implements MediaProvider {
  readonly id = 'minimax' as const
  readonly label = 'MiniMax H3（官方 API）'

  constructor(
    private readonly opts: {
      baseUrl: () => string
      apiKey: () => string
      defaultModel: () => string
      defaultResolution: () => string
    },
  ) {}

  capabilities(): ProviderCapability[] {
    return [
      {
        kind: 'video',
        models: MINIMAX_MODELS.map(m => m.id),
        mockable: true,
        note: 'T2V / I2V（first_frame+last_frame）/ R2V；content[] 官方参数直通',
      },
    ]
  }

  private headers(): Record<string, string> {
    const key = this.opts.apiKey()
    if (key === '') {
      throw new ForgeError('缺少 MiniMax API Key：面板「设置」填入，或设置环境变量 MINIMAX_API_KEY', false)
    }
    return { authorization: 'Bearer ' + key, 'content-type': 'application/json' }
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    timeoutMs = 60000,
    signal?: AbortSignal,
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const url = this.opts.baseUrl().replace(/\/+$/, '') + path
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combineSignal(signal, timeoutMs),
      })
    } catch (error) {
      if (isAborted(signal)) throw new ForgeError('已取消', false, undefined, 'cancelled')
      throw new ForgeError('请求 MiniMax 失败：' + (error instanceof Error ? error.message : String(error)), true)
    }
    const text = await res.text()
    let payload: Record<string, unknown> = {}
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text) as Record<string, unknown>
      } catch {
        throw new ForgeError('MiniMax 返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 300), res.status >= 500)
      }
    }
    return { status: res.status, payload }
  }

  private explainFailure(status: number, payload: Record<string, unknown>): ForgeError {
    const err = (payload.error ?? {}) as Record<string, unknown>
    const type = String(err.type ?? 'error')
    const message = String(err.message ?? JSON.stringify(payload).slice(0, 300))
    if (status === 401) {
      return new ForgeError('MiniMax 鉴权失败（401）：' + message +
        '\n→ 检查 Key 是否属于国内站 api.minimaxi.com / 国际站 api.minimax.io（本站点不匹配时也会报 401）', false)
    }
    if (status === 402) return new ForgeError('MiniMax 余额不足（402）：' + message, false)
    if (status === 429) return new ForgeError('MiniMax 限流（429）：' + message, true)
    if (status === 422) return new ForgeError('MiniMax 参数不合法（422）：' + message, false)
    return new ForgeError('MiniMax 报错（' + status + ' / ' + type + '）：' + message, status >= 500)
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    if (this.opts.apiKey() === '') {
      return { provider: this.id, status: 'offline', detail: '未配置 MiniMax API Key', checkedAt: Date.now() }
    }
    try {
      // 免计费探测：列表查询；顺带确认站点是否与 Key 匹配。
      const { status, payload } = await this.request('GET', '/v2/query/video_generation', undefined, 20000)
      const latencyMs = Date.now() - started
      if (status === 200) {
        const total = Number(payload.total ?? (Array.isArray(payload.items) ? payload.items.length : 0))
        return {
          provider: this.id,
          status: 'ok',
          detail: '鉴权通过（' + this.opts.baseUrl() + '，近 7 天任务 ' + total + ' 个）',
          latencyMs,
          extra: { baseUrl: this.opts.baseUrl(), defaultModel: this.opts.defaultModel() },
          checkedAt: Date.now(),
        }
      }
      const error = this.explainFailure(status, payload)
      return {
        provider: this.id,
        status: status === 401 ? 'offline' : 'degraded',
        detail: error.message,
        latencyMs,
        extra: { baseUrl: this.opts.baseUrl(), hint: status === 401 ? '国内站 https://api.minimaxi.com ↔ 国际站 https://api.minimax.io' : undefined },
        checkedAt: Date.now(),
      }
    } catch (error) {
      return {
        provider: this.id,
        status: 'offline',
        detail: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
        checkedAt: Date.now(),
      }
    }
  }

  /** 组装官方 content[]：显式传入优先，否则按 prompt + 参考帧推导。 */
  private buildContent(params: Record<string, unknown>): Array<Record<string, unknown>> {
    if (Array.isArray(params.content) && params.content.length > 0) {
      return params.content as Array<Record<string, unknown>>
    }
    const prompt = String(params.prompt ?? '').trim()
    if (prompt === '') throw new ForgeError('prompt 不能为空（content 必须含一条非空 text）', false)
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]

    const first = params.firstFrameImage ?? params.first_frame_image ?? params.image
    if (typeof first === 'string' && first.trim() !== '') {
      content.push({ type: 'image_url', image_url: { url: toDataUrl(first.trim(), 'first_frame') }, role: 'first_frame' })
    }
    const last = params.lastFrameImage ?? params.last_frame_image
    if (typeof last === 'string' && last.trim() !== '') {
      if (typeof first !== 'string' || first.trim() === '') {
        throw new ForgeError('last_frame 必须与 first_frame 同时提供（官方限制）', false)
      }
      content.push({ type: 'image_url', image_url: { url: toDataUrl(last.trim(), 'last_frame') }, role: 'last_frame' })
    }
    const refs = params.referenceImages
    if (Array.isArray(refs)) {
      if (content.some(item => item.role === 'first_frame' || item.role === 'last_frame')) {
        throw new ForgeError('I2V 首尾帧与 R2V 参考图互斥：一次只能用一种', false)
      }
      if (refs.length > 9) throw new ForgeError('参考图最多 9 张', false)
      for (const ref of refs) {
        if (typeof ref !== 'string') continue
        content.push({ type: 'image_url', image_url: { url: toDataUrl(ref, 'reference_image') }, role: 'reference_image' })
      }
    }
    const refVideo = params.referenceVideo ?? params.reference_video
    if (typeof refVideo === 'string' && refVideo.trim() !== '') {
      content.push({ type: 'video_url', video_url: { url: refVideo.trim() }, role: 'reference_video' })
    }
    const refAudio = params.referenceAudio ?? params.reference_audio
    if (typeof refAudio === 'string' && refAudio.trim() !== '') {
      content.push({ type: 'audio_url', audio_url: { url: refAudio.trim() }, role: 'reference_audio' })
    }
    return content
  }

  private buildBody(params: Record<string, unknown>): Record<string, unknown> {
    const model = String(params.model ?? this.opts.defaultModel() ?? 'MiniMax-H3')
    const duration = Number(params.duration ?? 6)
    if (!Number.isFinite(duration) || duration < 4 || duration > 15) {
      throw new ForgeError('duration 必须是 4–15 的整数（Max 为 5–15）', false)
    }
    const resolution = String(params.resolution ?? this.opts.defaultResolution() ?? '768P').toUpperCase()
    if (!MINIMAX_RESOLUTIONS.includes(resolution)) {
      throw new ForgeError('resolution 只能是 ' + MINIMAX_RESOLUTIONS.join(' / '), false)
    }
    const body: Record<string, unknown> = {
      model,
      content: this.buildContent(params),
      resolution,
      duration: Math.round(duration),
    }
    const ratio = params.ratio === undefined ? undefined : String(params.ratio)
    if (ratio !== undefined && ratio !== '' && ratio !== 'auto') {
      // 官方限制：纯文本 T2V 场景 ratio 不能是 adaptive（i2v/r2v 才允许）
      const hasImage = (body.content as Array<Record<string, unknown>>).some(item => item.type === 'image_url')
      body.ratio = ratio === 'adaptive' && !hasImage ? '16:9' : ratio
    }
    if (typeof params.callback_url === 'string' && params.callback_url !== '') body.callback_url = params.callback_url
    // 固定 task 形态：便于统一解析；flat 形态仅作兼容。
    body.response_format = 'task'
    return body
  }

  /**
   * 只提交、不等待 —— 给桥接端点用。
   * ComfyUI 的 HTTP 节点有超时（默认 120s），而 H3 出片要 1–5 分钟，
   * 所以桥必须能"提交即返回 remoteTaskId"，由调用方后续轮询 queryTask()。
   */
  async submit(params: Record<string, unknown>): Promise<{ taskId: string; body: Record<string, unknown>; raw: Record<string, unknown> }> {
    const body = this.buildBody(params)
    const created = await this.request('POST', '/v2/video_generation', body, 120000)
    if (created.status !== 200 && created.status !== 201) throw this.explainFailure(created.status, created.payload)
    const taskId = String(created.payload.task_id ?? '')
    if (taskId === '') throw new ForgeError('MiniMax 未返回 task_id：' + JSON.stringify(created.payload).slice(0, 300), false)
    return { taskId, body, raw: created.payload }
  }

  /** 查询远端任务状态（不落盘、不下载），给桥接端点轮询用。 */
  async queryTask(taskId: string): Promise<Record<string, unknown>> {
    const res = await this.request('GET', '/v2/query/video_generation/' + encodeURIComponent(taskId), undefined, 30000)
    if (res.status !== 200) throw this.explainFailure(res.status, res.payload)
    return (res.payload.task ?? res.payload) as Record<string, unknown>
  }

  private async poll(taskId: string, timeoutMs: number, ctx: RunContext, request: TaskRequest, initialInterval = 3000): Promise<PollOutcome> {
    const deadline = Date.now() + timeoutMs
    let interval = initialInterval
    let attempt = 0
    for (;;) {
      if (isAborted(ctx.signal)) throw new ForgeError('已取消', false, undefined, 'cancelled')
      if (Date.now() > deadline) throw new ForgeError('等待 MiniMax 任务超时（' + Math.round(timeoutMs / 1000) + 's）', true)
      attempt += 1
      let res: { status: number; payload: Record<string, unknown> }
      try {
        res = await this.request('GET', '/v2/query/video_generation/' + encodeURIComponent(taskId), undefined, 30000, ctx.signal)
      } catch (error) {
        if (isAborted(ctx.signal)) throw new ForgeError('已取消', false, undefined, 'cancelled')
        if (attempt > 6) throw error
        ctx.log('查询抖动，' + interval + 'ms 后重试：' + (error instanceof Error ? error.message : String(error)))
        await sleep(interval, ctx.signal)
        interval = Math.min(Math.round(interval * 1.6), 15000)
        continue
      }
      if (res.status === 429) {
        await sleep(interval, ctx.signal)
        interval = Math.min(Math.round(interval * 1.6), 15000)
        continue
      }
      if (res.status !== 200) throw this.explainFailure(res.status, res.payload)
      const task = (res.payload.task ?? res.payload) as Record<string, unknown>
      const status = String(task.status ?? 'unknown')
      ctx.emit({
        type: 'progress', taskId: request.id, provider: this.id, at: Date.now(),
        message: 'MiniMax ' + status + '（已等 ' + Math.round((Date.now() - (deadline - timeoutMs)) / 1000) + 's）',
        data: { remoteTaskId: taskId, status },
      })
      if (status === 'succeeded') {
        const content = (task.content ?? {}) as Record<string, unknown>
        return { status, url: typeof content.url === 'string' ? content.url : undefined, raw: task }
      }
      if (status === 'failed' || status === 'cancelled') {
        const err = (task.error ?? {}) as Record<string, unknown>
        return { status, error: { code: String(err.code ?? ''), message: String(err.message ?? '') }, raw: task }
      }
      await sleep(interval, ctx.signal)
      interval = Math.min(Math.round(interval * 1.6), 15000)
    }
  }

  /** 把调度器解析好的上游产物（request.inputs）映射成官方 content 需要的位置参数。 */
  private withInputs(params: Record<string, unknown>, inputs: TaskRequest['inputs']): Record<string, unknown> {
    if (!Array.isArray(inputs) || inputs.length === 0) return params
    const merged: Record<string, unknown> = { ...params }
    const pick = (role: string): string | undefined => {
      const hit = inputs.find(item => item.role === role)
      const value = hit?.path ?? hit?.url
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    }
    // 首帧 / 尾帧
    const first = pick('first_frame') ?? pick('firstFrame')
    if (first !== undefined && merged.firstFrameImage === undefined) merged.firstFrameImage = first
    const last = pick('last_frame') ?? pick('lastFrame')
    if (last !== undefined && merged.lastFrameImage === undefined) merged.lastFrameImage = last
    // 参考图（可多张）
    const refs = inputs
      .filter(item => item.role === 'reference_image' || item.role === 'reference')
      .map(item => item.path ?? item.url)
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    if (refs.length > 0 && merged.referenceImages === undefined) merged.referenceImages = refs.map(r => r.trim())
    return merged
  }

  async run(request: TaskRequest, ctx: RunContext): Promise<TaskResult> {
    const started = Date.now()
    const params = this.withInputs(request.params, request.inputs)
    const body = this.buildBody(params)
    const baseUrl = this.opts.baseUrl().replace(/\/+$/, '')

    if (ctx.dryRun) {
      return {
        ok: true, taskId: request.id, provider: this.id, artifacts: [], seconds: 0, cached: false,
        warnings: ['dry-run：未发起请求'],
        wouldCall: { url: baseUrl + '/v2/video_generation', body: { ...body, content: String((body.content as unknown[]).length) + ' 条 content' } },
      }
    }

    const created = await this.request('POST', '/v2/video_generation', body, 120000)
    if (created.status !== 200 && created.status !== 201) throw this.explainFailure(created.status, created.payload)
    const taskId = String(created.payload.task_id ?? '')
    if (taskId === '') throw new ForgeError('MiniMax 未返回 task_id：' + JSON.stringify(created.payload).slice(0, 300), false)

    ctx.emit({ type: 'start', taskId: request.id, provider: this.id, at: Date.now(), message: 'MiniMax 任务已创建 ' + taskId, data: { remoteTaskId: taskId } })

    const timeoutMs = Number(params.timeoutMs ?? 900000)
    const outcome = await this.poll(taskId, Number.isFinite(timeoutMs) ? timeoutMs : 900000, ctx, request)
    if (outcome.status !== 'succeeded' || outcome.url === undefined) {
      const detail = outcome.error?.message ?? outcome.status
      return {
        ok: false, taskId: request.id, provider: this.id, artifacts: [], seconds: Math.round((Date.now() - started) / 100) / 10,
        cached: false, warnings: [], error: 'MiniMax 任务' + outcome.status + '：' + detail,
        usage: { remoteTaskId: taskId, status: outcome.status, code: outcome.error?.code },
      }
    }

    // 产物 URL 有时效（官方："download promptly"），立即下载落盘。
    const dl = await fetch(outcome.url, { signal: AbortSignal.timeout(300000) })
    if (!dl.ok) throw new ForgeError('下载 MiniMax 视频失败：HTTP ' + dl.status, true)
    const bytes = Buffer.from(await dl.arrayBuffer())
    const durationSec = Number(outcome.raw.duration ?? body.duration ?? 0) || undefined
    const name = 'minimax-' + String(body.model).replace(/[^\w.-]/g, '_') + '-' + taskId + '.mp4'
    const artifact = ctx.save('minimax', name, bytes, {
      id: request.id + '#video',
      kind: 'video',
      mime: 'video/mp4',
      durationSec,
      meta: {
        model: body.model,
        resolution: outcome.raw.resolution ?? body.resolution,
        ratio: outcome.raw.ratio ?? body.ratio ?? null,
        remoteTaskId: taskId,
        remoteUrl: outcome.url,
        prompt: String(params.prompt ?? '').slice(0, 2000),
      },
    })

    return {
      ok: true, taskId: request.id, provider: this.id, artifacts: [artifact],
      seconds: Math.round((Date.now() - started) / 100) / 10, cached: false, warnings: [],
      usage: { ...(outcome.raw.usage ?? {}), remoteTaskId: taskId },
    }
  }
}
