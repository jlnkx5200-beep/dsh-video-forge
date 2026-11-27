/**
 * ComfyUI Provider —— 本地工作流桥接。
 *
 * 能力：上传上游资产 → 占位符注入工作流 JSON → 提交 /prompt → WS/轮询等完成 → 拉产物落盘。
 * 健康：/system_stats（版本+显存）+ /queue（排队）+ /object_info（Dsh* 节点是否已装）。
 *
 * 降级策略（8GB 显存 / 16GB 内存的现实约束）：
 *   - 服务不在线 → status=offline，面板提示「跳过 ComfyUI 后处理」或「回退 Canvas/Shader」；
 *   - 显存 < 800MiB 或排队 > 0 → status=degraded，仍可提交但给出预估等待；
 *   - 提交被拒（节点缺失/参数不合法）→ 原样回传 node_errors，不吞异常。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  MediaProvider, ProviderCapability, ProviderHealth, RunContext, TaskRequest, TaskResult,
} from './types.js'
import { ForgeError } from './types.js'
import { ComfyClient, type ComfyExecProgress } from '../comfy/client.js'
import { resolvePlaceholders, collectPlaceholderPaths } from '../comfy/placeholders.js'

export interface ComfyProviderOptions {
  baseUrl: () => string
  workflowDir: () => string
  clientId: () => string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ComfyuiProvider implements MediaProvider {
  readonly id = 'comfyui' as const
  readonly label = 'ComfyUI（本地工作流）'

  constructor(private readonly opts: ComfyProviderOptions) {}

  capabilities(): ProviderCapability[] {
    return [
      {
        kind: 'image', models: ['workflow: *'], mockable: true,
        note: '任意 API 格式工作流；深度/法线/抠图/贴图加工与自定义节点编排',
      },
      { kind: 'video', models: ['workflow: *'], mockable: true, note: '工作流产出 mp4/webm 时直通' },
      { kind: 'asset', models: ['workflow: *'], mockable: true, note: '多通道资产（depth/normal/mask）批量导出' },
    ]
  }

  /**
   * clientId 必须每个任务唯一：ComfyUI 的 WS 以 client_id 为键，
   * 并发任务共用同一个 id 时，只有最后一个 socket 能收到消息，
   * 先前的任务会一直等到 WS 超时（实测 300s）才走 /history 兜底。
   */
  private client(suffix?: string): ComfyClient {
    const base = this.opts.clientId()
    return new ComfyClient(this.opts.baseUrl(), suffix === undefined ? base : base + '-' + suffix)
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now()
    const client = this.client()
    try {
      const stats = await client.systemStats()
      const queue = await client.queue().catch(() => ({ running: 0, pending: 0 }))
      let dshNodes: string[] = []
      try {
        const info = await client.objectInfo(20000)
        dshNodes = Object.keys(info).filter(name => name.startsWith('Dsh'))
      } catch {
        /* /object_info 很大，失败不影响健康结论 */
      }
      const vramFree = stats.vramFreeMiB
      const degraded = (vramFree !== undefined && vramFree < 800) || queue.pending > 2
      const parts = [
        'v' + stats.comfyuiVersion,
        stats.deviceName === undefined ? '无 GPU' : String(stats.deviceName).slice(0, 32),
        vramFree === undefined ? '显存未知' : '显存余 ' + vramFree + ' MiB',
        '队列 ' + queue.running + ' 跑 / ' + queue.pending + ' 等',
        dshNodes.length > 0 ? 'Dsh 节点 ' + dshNodes.length + ' 个' : '未装 Dsh 节点',
      ]
      return {
        provider: this.id,
        status: degraded ? 'degraded' : 'ok',
        detail: parts.join(' · '),
        latencyMs: Date.now() - started,
        extra: {
          baseUrl: this.opts.baseUrl(),
          version: stats.comfyuiVersion,
          vramFreeMiB: vramFree,
          vramTotalMiB: stats.vramTotalMiB,
          ramFreeMiB: stats.ramFreeMiB,
          queue,
          dshNodes,
        },
        checkedAt: Date.now(),
      }
    } catch (error) {
      return {
        provider: this.id,
        status: 'offline',
        detail: '未连接 ' + this.opts.baseUrl() + '：' + (error instanceof Error ? error.message : String(error)) +
          '\n→ 启动 ComfyUI 后重试，或跳过后处理步骤（depth / matte 都是可选任务）',
        latencyMs: Date.now() - started,
        extra: { baseUrl: this.opts.baseUrl() },
        checkedAt: Date.now(),
      }
    }
  }

  /** 工作流来源：内联对象 > 绝对/相对路径 > workflowDir 下的文件名。 */
  private loadWorkflow(params: Record<string, unknown>): { workflow: Record<string, unknown>; source: string } {
    if (isPlainObject(params.workflow)) return { workflow: params.workflow, source: 'inline' }
    const candidates: string[] = []
    if (typeof params.workflowPath === 'string' && params.workflowPath !== '') {
      candidates.push(isAbsolute(params.workflowPath) ? params.workflowPath : resolve(this.opts.workflowDir(), params.workflowPath))
    }
    if (typeof params.workflowName === 'string' && params.workflowName !== '') {
      candidates.push(join(this.opts.workflowDir(), params.workflowName))
    }
    for (const path of candidates) {
      if (!existsSync(path)) continue
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        // 兼容 UI 导出（{nodes:[...],links:[...]}）：本 provider 只吃 API 格式，明确报错而不是静默失败。
        if (Array.isArray((parsed as { nodes?: unknown }).nodes) && !isPlainObject((parsed as { prompt?: unknown }).prompt)) {
          throw new ForgeError('工作流是 UI 导出格式（nodes/links），需要「Save (API Format)」导出的 API JSON：' + path, false)
        }
        const inner = isPlainObject(parsed.prompt) ? (parsed.prompt as Record<string, unknown>) : parsed
        return { workflow: inner, source: relative(this.opts.workflowDir(), path) || path }
      } catch (error) {
        if (error instanceof ForgeError) throw error
        throw new ForgeError('工作流 JSON 解析失败（' + path + '）：' + (error instanceof Error ? error.message : String(error)), false)
      }
    }
    throw new ForgeError('缺少 workflow：传 params.workflow（API JSON 对象）或 params.workflowName（位于 ' + this.opts.workflowDir() + '）', false)
  }

  async run(request: TaskRequest, ctx: RunContext): Promise<TaskResult> {
    const started = Date.now()
    const params = request.params
    const { workflow, source } = this.loadWorkflow(params)
    // 每个任务独立 clientId（见 client() 注释）
    const client = this.client(request.id.replace(/[^\w.-]+/g, '_'))

    // 1) 上传上游资产 → 得到 ComfyUI 侧可用的文件名（LoadImage 只认 input 目录里的文件）
    const assetScope: Record<string, unknown> = {}
    for (const input of request.inputs ?? []) {
      if (input.path === undefined || input.path === '') continue
      if (ctx.dryRun) {
        assetScope[input.role] = 'DRYRUN_' + input.role
        continue
      }
      try {
        const uploaded = await client.upload(input.path, { subfolder: 'dsh-video-forge' })
        assetScope[input.role] = uploaded
        assetScope[input.role + 'Path'] = input.path
        ctx.log('已上传 ' + input.role + ' → ' + uploaded)
      } catch (error) {
        throw new ForgeError('上传 ' + input.role + ' 到 ComfyUI 失败：' + (error instanceof Error ? error.message : String(error)), true)
      }
    }

    const context = isPlainObject(params.context) ? params.context : {}
    const scope = { ...context, asset: assetScope, env: { ...process.env } }
    const strict = params.strict !== false
    const injected = resolvePlaceholders(workflow, scope, { strict })
    const referenced = collectPlaceholderPaths(workflow)

    if (ctx.dryRun) {
      return {
        ok: true, taskId: request.id, provider: this.id, artifacts: [], seconds: 0, cached: false,
        warnings: ['dry-run：未提交工作流'],
        wouldCall: { url: this.opts.baseUrl() + '/prompt', workflowSource: source, placeholders: referenced, assets: Object.keys(assetScope) },
      }
    }

    ctx.emit({ type: 'start', taskId: request.id, provider: this.id, at: Date.now(), message: '提交工作流 ' + source })

    const timeoutMs = Number(params.timeoutMs ?? 900000)
    const onProgress = (progress: ComfyExecProgress): void => {
      const total = progress.max !== undefined && progress.max > 0 ? progress.max : undefined
      ctx.emit({
        type: 'progress', taskId: request.id, provider: this.id, at: Date.now(),
        progress: total !== undefined && progress.value !== undefined ? progress.value / total : undefined,
        message: progress.status === 'progress'
          ? '节点 ' + (progress.nodeId ?? '?') + ' ' + (progress.value ?? 0) + '/' + (total ?? '?')
          : (progress.message ?? progress.status),
        data: progress,
      })
    }

    let outcome
    try {
      outcome = await client.runWorkflow(injected, { onProgress, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 900000, signal: ctx.signal })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ForgeError(message, message.includes('超时') || message.includes('拒绝'))
    }

    if (outcome.files.length === 0) {
      return {
        ok: false, taskId: request.id, provider: this.id, artifacts: [], seconds: outcome.seconds, cached: false,
        warnings: ['工作流执行完成但没有输出节点产物（检查是否连了 SaveImage/PreviewImage）'],
        error: '无产物',
        usage: { promptId: outcome.promptId, via: outcome.via, workflowSource: source, placeholders: referenced },
      }
    }

    const artifacts = []
    for (const file of outcome.files) {
      const bytes = await client.download(file)
      const name = 'comfy-' + file.nodeId + '-' + file.filename.replace(/[^\w.-]/g, '_')
      const isVideo = file.kind === 'video' || /\.(mp4|webm|mov)$/i.test(file.filename)
      artifacts.push(ctx.save('comfy', name, bytes, {
        id: request.id + '#' + file.nodeId + '-' + file.filename,
        kind: isVideo ? 'video' : 'image',
        mime: isVideo ? 'video/mp4' : undefined,
        meta: { nodeId: file.nodeId, source: file.filename, subfolder: file.subfolder, workflowSource: source, promptId: outcome.promptId },
      }))
      ctx.emit({ type: 'progress', taskId: request.id, provider: this.id, at: Date.now(), message: '已落地 ' + file.filename })
    }

    // 输出产物清单落一份 JSON，方便面板/调试复盘（不进产出 Artifact 列表）
    if (params.dumpWorkflow === true) {
      try {
        const dir = join(ctx.tmpDir, 'comfy')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, request.id + '.injected.json'), JSON.stringify(injected, null, 2), 'utf8')
      } catch {
        /* 调试落盘失败不影响主流程 */
      }
    }

    return {
      ok: true, taskId: request.id, provider: this.id, artifacts,
      seconds: outcome.seconds, cached: false,
      warnings: outcome.via === 'poll' ? ['WebSocket 未生效，已用 /history 轮询'] : [],
      usage: { promptId: outcome.promptId, via: outcome.via, workflowSource: source, placeholders: referenced, injectedAt: Date.now() - started },
    }
  }
}
