/**
 * Seedream Provider —— 火山方舟「即梦同源」文生图 / 图生图。
 *
 * 与 `@dsh-external/dsh-seedream` **同协议**（同 baseUrl、同 /images/generations、同错误语义），
 * 但独立实现：本插件多了 seed 锁定与参考图（I2I），并统一输出 Artifact。
 */
import { readFileSync, existsSync } from 'node:fs'
import { extname } from 'node:path'
import type {
  MediaProvider, ProviderCapability, ProviderHealth, RunContext, TaskRequest, TaskResult,
} from './types.js'
import { ForgeError } from './types.js'
import { isAborted } from '../http.js'
import { sniffExt } from '../http.js'

export interface SeedreamModelInfo {
  alias: string
  id: string
  label: string
  note: string
}

/** 与 dsh-seedream 保持同一张表：id 一旦漂移两处会静默失败，故注释交叉索引。 */
export const SEEDREAM_MODELS: SeedreamModelInfo[] = [
  { alias: '5.5', id: 'doubao-seedream-5-5-261028', label: 'Seedream 5.5', note: '最新：图层拆分、原生透明图' },
  { alias: '5.0-pro', id: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro', note: '质量档，出关键帧' },
  { alias: '5.0-flash', id: 'doubao-seedream-5-0-flash-260915', label: 'Seedream 5.0 Flash', note: '快且便宜，批量首选' },
  { alias: '4.0', id: 'doubao-seedream-4-0-20260415', label: 'Seedream 4.0', note: '上一代' },
]

export const SEEDREAM_SIZES = ['1024x1024', '2048x1152', '1152x2048', '2048x2048', '2K', '4K']

export function resolveSeedreamModel(input: unknown, fallback: string): SeedreamModelInfo {
  const wanted = (typeof input === 'string' ? input : fallback || '5.0-flash').trim()
  const lower = wanted.toLowerCase()
  const hit = SEEDREAM_MODELS.find(m => m.alias.toLowerCase() === lower || m.id === wanted || m.label.toLowerCase() === lower)
  if (hit) return hit
  if (wanted !== '') return { alias: wanted, id: wanted, label: wanted, note: 'custom（直接透传 Model ID）' }
  return SEEDREAM_MODELS[2]!
}

/** 本地参考图 → data URL（方舟接受 https URL 或 data:image/...;base64）。 */
function toImageRef(value: string): string {
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value
  if (existsSync(value)) {
    const bytes = readFileSync(value)
    const ext = extname(value).toLowerCase()
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
    return 'data:' + mime + ';base64,' + bytes.toString('base64')
  }
  return value
}

export class SeedreamProvider implements MediaProvider {
  readonly id = 'seedream' as const
  readonly label = 'Seedream（火山方舟）'

  constructor(
    private readonly opts: {
      baseUrl: () => string
      apiKey: () => string
      defaultModel: () => string
      maxImagesPerCall: () => number
    },
  ) {}

  capabilities(): ProviderCapability[] {
    return [
      {
        kind: 'image',
        models: SEEDREAM_MODELS.map(m => m.alias),
        mockable: true,
        note: 'T2I / I2I（image 参考图）、多比例、seed 锁定',
      },
    ]
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const key = this.opts.apiKey()
    if (key === '') {
      return { provider: this.id, status: 'offline', detail: '未配置 ARK API Key（面板设置或 ARK_API_KEY）', checkedAt: Date.now() }
    }
    return {
      provider: this.id,
      status: 'ok',
      detail: 'Key 已配置（未探活：出图接口按张计费，不做探测请求）',
      latencyMs: Date.now() - started,
      extra: { baseUrl: this.opts.baseUrl(), defaultModel: this.opts.defaultModel() },
      checkedAt: Date.now(),
    }
  }

  private async callArk(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const key = this.opts.apiKey()
    if (key === '') throw new ForgeError('缺少 ARK API Key：面板「设置」填入，或写入 ~/.dsh/video-forge.json 的 arkApiKey', false)
    const url = this.opts.baseUrl() + '/images/generations'
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: signal === undefined ? AbortSignal.timeout(timeoutMs) : signal,
      })
    } catch (error) {
      if (isAborted(signal)) throw new ForgeError('已取消', false, undefined, 'cancelled')
      throw new ForgeError('请求方舟失败：' + (error instanceof Error ? error.message : String(error)), true)
    }
    const text = await res.text()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new ForgeError('方舟返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 300), res.status >= 500)
    }
    if (!res.ok) {
      const err = (payload.error ?? {}) as Record<string, unknown>
      const code = String(err.code ?? 'HTTP' + res.status)
      const message = String(err.message ?? text.slice(0, 300))
      const retryable = res.status === 429 || res.status >= 500 || code === 'SetLimitExceeded'
      if (code === 'SetLimitExceeded' || res.status === 429) {
        throw new ForgeError('方舟限流/额度不足（' + code + '）：' + message + '\n→ 方舟控制台「开通管理」检查用量上限与余额', true)
      }
      if (code === 'ModelNotOpen') {
        throw new ForgeError('模型未开通（' + code + '）：' + message + '\n→ https://console.volcengine.com/ark 开通该 Seedream 模型', false)
      }
      throw new ForgeError('方舟报错（' + code + '）：' + message, retryable)
    }
    return payload
  }

  async run(request: TaskRequest, ctx: RunContext): Promise<TaskResult> {
    const started = Date.now()
    const params = request.params
    const prompt = String(params.prompt ?? '').trim()
    if (prompt === '') throw new ForgeError('prompt 不能为空', false)

    const model = resolveSeedreamModel(params.model, this.opts.defaultModel())
    const requested = Number(params.count ?? 1)
    const count = Math.min(Math.max(Number.isFinite(requested) ? Math.floor(requested) : 1, 1), this.opts.maxImagesPerCall())
    const size = String(params.size ?? '2048x1152').trim() || '2048x1152'
    const watermark = params.watermark === true
    const seed = Number.isFinite(Number(params.seed)) ? Math.floor(Number(params.seed)) : undefined

    const body: Record<string, unknown> = {
      model: model.id,
      prompt,
      size,
      response_format: 'url',
      watermark,
    }
    if (seed !== undefined) body.seed = seed
    if (count > 1) {
      body.sequential_image_generation = 'auto'
      body.sequential_image_generation_options = { max_images: count }
    }
    const refValue = params.image ?? params.referenceImage
    if (typeof refValue === 'string' && refValue.trim() !== '') body.image = [toImageRef(refValue.trim())]

    if (ctx.dryRun) {
      return {
        ok: true, taskId: request.id, provider: this.id, artifacts: [], seconds: 0, cached: false,
        warnings: ['dry-run：未发起请求'], wouldCall: { url: this.opts.baseUrl() + '/images/generations', body },
      }
    }

    ctx.emit({ type: 'start', taskId: request.id, provider: this.id, at: Date.now(), message: model.label + ' · ' + size + ' × ' + count })
    const payload = await this.callArk(body, 300000, ctx.signal)
    const items = Array.isArray(payload.data) ? (payload.data as Array<Record<string, unknown>>) : []
    if (items.length === 0) throw new ForgeError('方舟没有返回图片：' + JSON.stringify(payload).slice(0, 300), false)

    const artifacts = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? {}
      let bytes: Buffer | undefined
      if (typeof item.url === 'string' && item.url !== '') {
        const dl = await fetch(item.url, { signal: ctx.signal ?? AbortSignal.timeout(120000) })
        if (!dl.ok) throw new ForgeError('下载生成图失败：HTTP ' + dl.status, true)
        bytes = Buffer.from(await dl.arrayBuffer())
      } else if (typeof item.b64_json === 'string') {
        bytes = Buffer.from(item.b64_json, 'base64')
      }
      if (bytes === undefined) continue
      const suffix = items.length > 1 ? '-' + (i + 1) : ''
      const name = 'seedream-' + model.alias.replace(/[^\w.-]/g, '_') + '-' + (seed ?? 'rnd') + suffix + sniffExt(bytes)
      const artifact = ctx.save('seedream', name, bytes, {
        id: request.id + '#' + i,
        kind: 'image',
        mime: sniffExt(bytes) === '.jpg' ? 'image/jpeg' : 'image/png',
        width: undefined,
        meta: { model: model.id, alias: model.alias, size: String(item.size ?? size), seed: seed ?? null, prompt },
      })
      artifacts.push(artifact)
      ctx.emit({ type: 'progress', taskId: request.id, provider: this.id, at: Date.now(), progress: (i + 1) / items.length, message: '已落地 ' + (i + 1) + '/' + items.length })
    }
    if (artifacts.length === 0) throw new ForgeError('图片下载全部失败', true)

    return {
      ok: true,
      taskId: request.id,
      provider: this.id,
      artifacts,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      cached: false,
      warnings: artifacts.length < count ? ['方舟只返回 ' + artifacts.length + '/' + count + ' 张'] : [],
      usage: (payload.usage ?? {}) as Record<string, unknown>,
    }
  }
}
