/**
 * ComfyUI HTTP / WebSocket 客户端 —— 纯 TypeScript，零依赖（用全局 fetch + 全局 WebSocket）。
 *
 * 覆盖：/system_stats（健康+显存）、/object_info（节点能力发现）、/upload/image、/prompt、/history、
 * /view、/queue、/interrupt、/ws（实时执行进度）。
 *
 * 关于 WebSocket：Node ≥ 22 自带全局 WebSocket（undici）。若运行时没有，则自动退化为 /history 轮询，
 * 只是少了「采样步进度」这一层实时性，不影响正确性。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

export interface ComfySystemStats {
  comfyuiVersion: string
  pythonVersion?: string
  deviceName?: string
  vramTotalMiB?: number
  vramFreeMiB?: number
  ramTotalMiB?: number
  ramFreeMiB?: number
  raw: Record<string, unknown>
}

export interface ComfyQueueState {
  running: number
  pending: number
}

export interface ComfyHistoryFile {
  filename: string
  subfolder: string
  type: string
  nodeId: string
  kind: 'image' | 'video'
}

export interface ComfyExecProgress {
  promptId: string
  nodeId?: string
  value?: number
  max?: number
  status: 'started' | 'progress' | 'cached' | 'node-done' | 'done' | 'error' | 'interrupted'
  message?: string
}

export interface ComfySubmitResult {
  promptId: string
  number?: number
  nodeErrors?: Array<{ nodeId: string; message: string }>
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1) + 's'
}

export class ComfyClient {
  private objectInfoCache?: { at: number; data: Record<string, unknown> }

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
  ) {}

  get url(): string {
    return this.baseUrl.replace(/\/+$/, '')
  }

  private wsUrl(): string {
    return this.url.replace(/^http/i, ws => (ws.toLowerCase() === 'https' ? 'wss' : 'ws')) + '/ws?clientId=' + encodeURIComponent(this.clientId)
  }

  private async httpJson(path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<{ status: number; payload: Record<string, unknown> }> {
    const res = await fetch(this.url + path, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    let payload: Record<string, unknown> = {}
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text) as Record<string, unknown>
      } catch {
        throw new Error('ComfyUI 返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200))
      }
    }
    return { status: res.status, payload }
  }

  async systemStats(timeoutMs = 6000): Promise<ComfySystemStats> {
    const { status, payload } = await this.httpJson('/system_stats', {}, timeoutMs)
    if (status !== 200) throw new Error('ComfyUI /system_stats HTTP ' + status)
    const system = (payload.system ?? {}) as Record<string, unknown>
    const devices = Array.isArray(payload.devices) ? (payload.devices as Array<Record<string, unknown>>) : []
    const gpu = devices.find(d => String(d.type ?? '').toLowerCase().includes('cuda')) ?? devices[0]
    const device = (gpu ?? {}) as Record<string, unknown>
    const bytesToMiB = (value: unknown): number | undefined => {
      const n = Number(value)
      return Number.isFinite(n) && n > 0 ? Math.round(n / 1048576) : undefined
    }
    return {
      comfyuiVersion: String(system.comfyui_version ?? 'unknown'),
      pythonVersion: system.python_version === undefined ? undefined : String(system.python_version),
      deviceName: device.name === undefined ? undefined : String(device.name),
      vramTotalMiB: bytesToMiB(device.vram_total),
      vramFreeMiB: bytesToMiB(device.vram_free),
      ramTotalMiB: bytesToMiB(system.ram_total),
      ramFreeMiB: bytesToMiB(system.ram_free),
      raw: payload,
    }
  }

  async queue(timeoutMs = 8000): Promise<ComfyQueueState> {
    const { status, payload } = await this.httpJson('/queue', {}, timeoutMs)
    if (status !== 200) throw new Error('ComfyUI /queue HTTP ' + status)
    const running = Array.isArray(payload.queue_running) ? payload.queue_running.length : 0
    const pending = Array.isArray(payload.queue_pending) ? payload.queue_pending.length : 0
    return { running, pending }
  }

  /** 节点能力快照（5 分钟缓存）：面板据此判断 Dsh* 节点是否已安装。 */
  async objectInfo(timeoutMs = 20000): Promise<Record<string, unknown>> {
    if (this.objectInfoCache !== undefined && Date.now() - this.objectInfoCache.at < 300000) return this.objectInfoCache.data
    const { status, payload } = await this.httpJson('/object_info', {}, timeoutMs)
    if (status !== 200) throw new Error('ComfyUI /object_info HTTP ' + status)
    this.objectInfoCache = { at: Date.now(), data: payload }
    return payload
  }

  /** 上传本地文件 → ComfyUI input 目录，返回可用于 LoadImage 的名字。 */
  async upload(filePath: string, options: { subfolder?: string; overwrite?: boolean } = {}): Promise<string> {
    if (!existsSync(filePath)) throw new Error('待上传文件不存在：' + filePath)
    const bytes = readFileSync(filePath)
    const name = basename(filePath)
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(bytes)], { type: MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' }), name)
    form.append('overwrite', options.overwrite === false ? 'false' : 'true')
    if (options.subfolder !== undefined && options.subfolder !== '') form.append('subfolder', options.subfolder)
    const res = await fetch(this.url + '/upload/image', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) })
    const text = await res.text()
    if (!res.ok) throw new Error('上传到 ComfyUI 失败（HTTP ' + res.status + '）：' + text.slice(0, 200))
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      return name
    }
    const stored = String(payload.name ?? name)
    const sub = String(payload.subfolder ?? '')
    return sub === '' ? stored : sub + '/' + stored
  }

  async submit(workflow: Record<string, unknown>, extraData: Record<string, unknown> = {}): Promise<ComfySubmitResult> {
    const { status, payload } = await this.httpJson('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId, extra_data: extraData }),
    }, 60000)
    if (status !== 200) {
      const nodeErrors = this.parseNodeErrors(payload)
      const detail = nodeErrors.length > 0
        ? nodeErrors.map(e => e.nodeId + ': ' + e.message).join('；')
        : JSON.stringify(payload).slice(0, 400)
      throw new Error('ComfyUI 拒绝工作流（HTTP ' + status + '）：' + detail)
    }
    const promptId = String(payload.prompt_id ?? '')
    if (promptId === '') throw new Error('ComfyUI 未返回 prompt_id：' + JSON.stringify(payload).slice(0, 300))
    return { promptId, number: Number(payload.number) || undefined, nodeErrors: this.parseNodeErrors(payload) }
  }

  private parseNodeErrors(payload: Record<string, unknown>): Array<{ nodeId: string; message: string }> {
    const out: Array<{ nodeId: string; message: string }> = []
    const nodeErrors = payload.node_errors
    if (nodeErrors !== undefined && nodeErrors !== null && typeof nodeErrors === 'object' && !Array.isArray(nodeErrors)) {
      for (const [nodeId, value] of Object.entries(nodeErrors as Record<string, unknown>)) {
        const item = (value ?? {}) as Record<string, unknown>
        const errors = Array.isArray(item.errors) ? (item.errors as Array<Record<string, unknown>>) : []
        const message = errors.map(e => String(e.message ?? e.details ?? '')).filter(Boolean).join(' / ') || JSON.stringify(item).slice(0, 200)
        out.push({ nodeId, message })
      }
    }
    if (out.length === 0 && payload.error !== undefined) {
      const err = payload.error as Record<string, unknown>
      out.push({ nodeId: String(err.node_id ?? '?'), message: String(err.message ?? err.type ?? 'unknown error') })
    }
    return out
  }

  async history(promptId: string, timeoutMs = 20000): Promise<Record<string, unknown> | null> {
    const { status, payload } = await this.httpJson('/history/' + encodeURIComponent(promptId), {}, timeoutMs)
    if (status !== 200) throw new Error('ComfyUI /history HTTP ' + status)
    const entry = payload[promptId]
    return entry !== undefined && entry !== null ? (entry as Record<string, unknown>) : null
  }

  /** /history 里 outputs 的产物清单（images / videos / gifs 三种键都认）。 */
  collectOutputs(entry: Record<string, unknown>): ComfyHistoryFile[] {
    const files: ComfyHistoryFile[] = []
    const outputs = (entry.outputs ?? {}) as Record<string, unknown>
    for (const [nodeId, value] of Object.entries(outputs)) {
      const node = (value ?? {}) as Record<string, unknown>
      const groups: Array<[string, 'image' | 'video']> = [
        ['images', 'image'],
        ['gifs', 'video'],
        ['videos', 'video'],
        ['video', 'video'],
      ]
      for (const [key, kind] of groups) {
        const list = node[key]
        if (!Array.isArray(list)) continue
        for (const item of list as Array<Record<string, unknown>>) {
          const filename = String(item.filename ?? '')
          if (filename === '') continue
          files.push({
            filename,
            subfolder: String(item.subfolder ?? ''),
            type: String(item.type ?? 'output'),
            nodeId,
            kind,
          })
        }
      }
    }
    return files
  }

  async download(file: ComfyHistoryFile, timeoutMs = 300000): Promise<Buffer> {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
    const res = await fetch(this.url + '/view?' + query.toString(), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error('拉取 ComfyUI 产物失败（HTTP ' + res.status + ' / ' + file.filename + '）')
    return Buffer.from(await res.arrayBuffer())
  }

  async interrupt(timeoutMs = 8000): Promise<void> {
    try {
      await this.httpJson('/interrupt', { method: 'POST' }, timeoutMs)
    } catch {
      /* 尽力而为：服务已断时中断必然失败 */
    }
  }

  /**
   * 执行工作流并等待完成。
   * 优先 WebSocket 实时进度；没有全局 WebSocket 或连接失败时退化为 /history 轮询。
   */
  async runWorkflow(
    workflow: Record<string, unknown>,
    hooks: {
      onProgress?: (progress: ComfyExecProgress) => void
      timeoutMs?: number
      signal?: AbortSignal
      pollMs?: number
    } = {},
  ): Promise<{ promptId: string; entry: Record<string, unknown>; files: ComfyHistoryFile[]; seconds: number; via: 'ws' | 'poll' }> {
    const startedAt = Date.now()
    const timeoutMs = hooks.timeoutMs ?? 900000
    const submitted = await this.submit(workflow)
    const promptId = submitted.promptId
    hooks.onProgress?.({ promptId, status: 'started', message: 'prompt ' + promptId })

    const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket
    if (WebSocketCtor !== undefined) {
      const viaWs = await this.watchViaWebSocket(WebSocketCtor, promptId, hooks, timeoutMs)
      if (viaWs !== null) {
        const entry = viaWs
        if (entry !== null) {
          const files = this.collectOutputs(entry)
          if (files.length > 0) {
            return { promptId, entry, files, seconds: Math.round((Date.now() - startedAt) / 100) / 10, via: 'ws' }
          }
        }
      }
      // WS 通道未能确认产物：落到轮询兜底（例如 WS 被代理拦截、或产出节点未被广播）。
    }
    return this.pollHistory(promptId, hooks, timeoutMs, startedAt)
  }

  private watchViaWebSocket(
    WebSocketCtor: new (url: string) => WebSocket,
    promptId: string,
    hooks: { onProgress?: (progress: ComfyExecProgress) => void; signal?: AbortSignal },
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    return new Promise(resolve => {
      let settled = false
      let socket: WebSocket
      const finish = (value: Record<string, unknown> | null): void => {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch {
          /* noop */
        }
        resolve(value)
      }
      try {
        socket = new WebSocketCtor(this.wsUrl())
      } catch {
        resolve(null)
        return
      }
      const timer = setTimeout(() => finish(null), Math.min(timeoutMs, 300000))
      const cleanup = (): void => clearTimeout(timer)
      socket.onerror = () => {
        cleanup()
        finish(null)
      }
      socket.onclose = () => {
        cleanup()
        finish(null)
      }
      socket.onmessage = (event: MessageEvent) => {
        const raw = typeof event.data === 'string' ? event.data : ''
        if (raw === '') return
        let message: Record<string, unknown>
        try {
          message = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return
        }
        const type = String(message.type ?? '')
        const data = (message.data ?? {}) as Record<string, unknown>
        const messagePromptId = String(data.prompt_id ?? '')
        if (messagePromptId !== '' && messagePromptId !== promptId) return

        if (type === 'progress') {
          hooks.onProgress?.({
            promptId,
            nodeId: data.node === undefined ? undefined : String(data.node),
            value: Number(data.value) || 0,
            max: Number(data.max) || 0,
            status: 'progress',
          })
          return
        }
        if (type === 'executing' && data.node === null) {
          // ComfyUI 的「执行结束」信号：此时 /history 已写好。
          void this.history(promptId).then(entry => {
            cleanup()
            hooks.onProgress?.({ promptId, status: 'done' })
            finish(entry)
          }).catch(() => {
            cleanup()
            finish(null)
          })
          return
        }
        if (type === 'execution_error') {
          cleanup()
          hooks.onProgress?.({ promptId, status: 'error', message: String(data.exception_message ?? data.exception_type ?? 'execution error') })
          finish(null)
          return
        }
        if (type === 'execution_interrupted') {
          cleanup()
          hooks.onProgress?.({ promptId, status: 'interrupted', message: '被中断' })
          finish(null)
          return
        }
        if (type === 'execution_cached') {
          hooks.onProgress?.({ promptId, status: 'cached', message: '命中 ComfyUI 自身缓存' })
        }
      }
    })
  }

  private async pollHistory(
    promptId: string,
    hooks: { onProgress?: (progress: ComfyExecProgress) => void; signal?: AbortSignal },
    timeoutMs: number,
    startedAt: number,
  ): Promise<{ promptId: string; entry: Record<string, unknown>; files: ComfyHistoryFile[]; seconds: number; via: 'ws' | 'poll' }> {
    const deadline = Date.now() + timeoutMs
    const pollMs = 1500
    for (;;) {
      if (hooks.signal?.aborted === true) {
        await this.interrupt()
        throw new Error('已取消（已向 ComfyUI 发送 /interrupt）')
      }
      if (Date.now() > deadline) {
        await this.interrupt()
        throw new Error('等待 ComfyUI 执行超时（' + seconds(timeoutMs) + '）')
      }
      let entry: Record<string, unknown> | null = null
      try {
        entry = await this.history(promptId)
      } catch (error) {
        hooks.onProgress?.({ promptId, status: 'progress', message: (error instanceof Error ? error.message : String(error)) })
      }
      if (entry !== null) {
        const status = (entry.status ?? {}) as Record<string, unknown>
        const completed = status.completed === true
        const statusStr = String(status.status_str ?? '')
        if (completed || statusStr === 'success' || entry.outputs !== undefined) {
          hooks.onProgress?.({ promptId, status: 'done' })
          return {
            promptId,
            entry,
            files: this.collectOutputs(entry),
            seconds: Math.round((Date.now() - startedAt) / 100) / 10,
            via: 'poll',
          }
        }
        if (statusStr === 'error') {
          hooks.onProgress?.({ promptId, status: 'error', message: statusStr })
          throw new Error('ComfyUI 执行失败：' + JSON.stringify(status).slice(0, 300))
        }
      }
      hooks.onProgress?.({ promptId, status: 'progress', message: '执行中… ' + seconds(Date.now() - startedAt) })
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  }
}
