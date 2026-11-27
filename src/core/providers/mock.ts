/**
 * Mock Provider —— 零成本离线预演。
 *
 * 目的：调 Remotion 时间轴、调 Three.js 运镜、调面板交互时，**一次都不该扣钱**。
 * 产物是真实可读的文件：图片用内置确定性 PNG 编码器（同 seed 同字节），
 * 视频优先用本机 ffmpeg 合成 2 秒 testsrc2 片段（真 mp4，能被 <video> seek），
 * 没有 ffmpeg 时退化为静帧 PNG（meta.mockVideoStill = true，面板会标黄）。
 *
 * mock 的产物**不进内容缓存**（避免污染真实指纹），指纹里 provider=mock 天然隔离。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  MediaProvider, ProviderCapability, ProviderHealth, RunContext, TaskRequest, TaskResult,
} from './types.js'
import { hashSeed, inferSize, renderPlaceholderPng } from '../png.js'

export class MockProvider implements MediaProvider {
  readonly id = 'mock' as const
  readonly label = 'Mock（离线零成本）'

  constructor(private readonly opts: { ffmpegPath: () => string }) {}

  capabilities(): ProviderCapability[] {
    return [
      { kind: 'image', models: ['mock'], mockable: true, note: '确定性占位图（PNG）' },
      { kind: 'video', models: ['mock'], mockable: true, note: 'ffmpeg testsrc2 合成 2s mp4；无 ffmpeg 时退化为静帧' },
      { kind: 'asset', models: ['mock'], mockable: true, note: '多通道占位资产' },
    ]
  }

  async health(): Promise<ProviderHealth> {
    const ffmpeg = this.opts.ffmpegPath()
    const hasFfmpeg = ffmpeg !== '' && existsSync(ffmpeg)
    return {
      provider: this.id,
      status: 'ok',
      detail: hasFfmpeg ? '占位图 + ffmpeg 合成视频均可用' : '占位图可用；未找到 ffmpeg，mock 视频将退化为静帧',
      extra: { ffmpegPath: ffmpeg, hasFfmpeg },
      checkedAt: Date.now(),
    }
  }

  private synthesizeVideo(request: TaskRequest, width: number, height: number, durationSec: number, dir: string): string | null {
    const ffmpeg = this.opts.ffmpegPath()
    if (ffmpeg === '' || !existsSync(ffmpeg)) return null
    const out = join(dir, 'mock-' + request.id.replace(/[^\w.-]/g, '_') + '.mp4')
    // testsrc2 是确定性图案；固定 rate/duration，保证同一请求产出同一时长。
    const args = [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=' + width + 'x' + height + ':rate=24:duration=' + durationSec,
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      out,
    ]
    const run = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 120000 })
    if (run.status !== 0 || !existsSync(out)) return null
    return out
  }

  async run(request: TaskRequest, ctx: RunContext): Promise<TaskResult> {
    const started = Date.now()
    const params = request.params
    const prompt = String(params.prompt ?? params.label ?? request.id)
    const seedInput = Number(params.seed)
    const seed = Number.isFinite(seedInput) ? Math.floor(seedInput) : hashSeed(prompt + '|' + request.provider + '|' + request.kind)
    const sizeHint = typeof params.size === 'string' && params.size !== ''
      ? params.size
      : params.width !== undefined && params.height !== undefined
        ? Number(params.width) + 'x' + Number(params.height)
        : '1280x720'
    const [width, height] = inferSize(sizeHint)
    const durationSec = Math.max(1, Math.min(15, Number(params.duration ?? 2) || 2))
    const warnings: string[] = []
    const artifacts = []

    const role = typeof params.role === 'string' ? params.role : request.kind

    if (request.kind === 'video') {
      const work = mkdtempSync(join(tmpdir(), 'forge-mock-'))
      try {
        const clip = this.synthesizeVideo(request, width, height, durationSec, work)
        if (clip !== null) {
          const bytes = readFileSync(clip)
          artifacts.push(ctx.save('mock', 'mock-' + seed + '-' + durationSec + 's.mp4', bytes, {
            id: request.id + '#mock-video', kind: 'video', mime: 'video/mp4', width, height, durationSec,
            meta: { mock: true, seed, role, prompt: prompt.slice(0, 500) },
          }))
        } else {
          warnings.push('未找到 ffmpeg：mock 视频退化为静帧 PNG（render 时请用 still 模式或换真实 Provider）')
        }
      } finally {
        try {
          rmSync(work, { recursive: true, force: true })
        } catch {
          /* noop */
        }
      }
    }

    if (artifacts.length === 0) {
      const png = renderPlaceholderPng({ width, height, seed })
      const assetRole = request.kind === 'video' ? 'video' : role
      artifacts.push(ctx.save('mock', 'mock-' + String(assetRole).replace(/[^\w.-]/g, '_') + '-' + seed + '.png', png, {
        id: request.id + '#mock-still', kind: 'image', mime: 'image/png', width, height,
        meta: { mock: true, seed, role: assetRole, prompt: prompt.slice(0, 500), mockVideoStill: request.kind === 'video' },
      }))
      if (request.kind === 'video') {
        const last = artifacts[artifacts.length - 1]!
        last.meta = { ...(last.meta ?? {}), mockVideoStill: true }
      }
    }

    // 多通道资产（depth / normal / mask）：同 seed 不同调色，便于验证"通道确实被分别消费"。
    if (request.kind === 'asset' || params.channels !== undefined) {
      const channels = Array.isArray(params.channels) ? (params.channels as unknown[]).map(String) : ['depth', 'normal', 'mask']
      for (const channel of channels) {
        const tint: Record<string, [number, number, number]> = {
          depth: [240, 240, 240], normal: [128, 128, 255], mask: [255, 255, 255],
        }
        const png = renderPlaceholderPng({ width: Math.min(width, 1024), height: Math.min(height, 1024), seed: seed + hashSeed(channel) % 997, colorA: [10, 10, 10], colorB: tint[channel] ?? [200, 200, 200], grid: false, horizon: null })
        artifacts.push(ctx.save('mock', 'mock-' + channel + '-' + seed + '.png', png, {
          id: request.id + '#' + channel, kind: 'image', mime: 'image/png',
          width: Math.min(width, 1024), height: Math.min(height, 1024),
          meta: { mock: true, seed, channel, role: channel },
        }))
      }
    }

    mkdirSync(join(ctx.tmpDir, 'mock'), { recursive: true })
    return {
      ok: true, taskId: request.id, provider: this.id, artifacts,
      seconds: Math.round((Date.now() - started) / 100) / 10, cached: false,
      warnings, usage: { mock: true, seed },
    }
  }
}
