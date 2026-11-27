/**
 * 极小的 HTTP 工具：路由响应、body 读取、本机访问守卫、媒体类型嗅探。
 *
 * 这些函数与 dsh-seedream 的同名实现保持**语义一致**（同一个 Web 壳里跑多插件，
 * 安全策略不能各写一套）：只允许回环地址 + Host 必须是回环 + 拒跨站 + Origin 同源。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, basename, resolve as resolvePath, sep } from 'node:path'
import { existsSync, statSync, readFileSync } from 'node:fs'

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export async function readJsonBody(req: IncomingMessage, limit = 4 << 20): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > limit) throw new Error('request body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  return JSON.parse(text)
}

/** 只允许本机浏览器访问（同源 + loopback），避免局域网他人用你的 Key 花钱。 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

export const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

export function contentTypeOf(fileName: string): string {
  return CONTENT_TYPES[extname(basename(fileName)).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 按 magic bytes 决定扩展名 —— 方舟对 PNG 尺寸请求常直接返回 JPEG，
 * 一律写 .png 会让扩展名与实际编码不符。视频按容器头识别。
 */
export function sniffExt(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12)
    if (brand.startsWith('qt')) return '.mov'
    return '.mp4'
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return '.webm'
  return '.bin'
}

/**
 * 把 URL 路径段安全地拼到 root 下：拒绝 `..`、绝对路径、盘符、分隔符。
 * 返回 null 表示非法。
 */
export function safeJoin(root: string, rel: string): string | null {
  if (rel === '') return null
  const normalized = rel.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..')) return null
  const abs = resolvePath(root, parts.join(sep))
  const rootAbs = resolvePath(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null
  return abs
}

export interface StaticFile {
  bytes: Buffer
  contentType: string
  size: number
}

export function readStaticFile(root: string, rel: string): StaticFile | null {
  const abs = safeJoin(root, rel)
  if (abs === null) return null
  if (!existsSync(abs)) return null
  const st = statSync(abs)
  if (!st.isFile()) return null
  return { bytes: readFileSync(abs), contentType: contentTypeOf(abs), size: st.size }
}

/** 直接读一个已经做过路径校验的绝对路径（产物静态服务用）。 */
export function readFileDirect(abs: string): StaticFile | null {
  if (!existsSync(abs)) return null
  const st = statSync(abs)
  if (!st.isFile()) return null
  return { bytes: readFileSync(abs), contentType: contentTypeOf(abs), size: st.size }
}

/** 一个可等待的睡眠（带 signal 取消）。 */
/** 取消判定：单独成函数，避免 TS 在"已排除 true"之后把后续比较判成无意义。 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted === true
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 稳定 JSON（键排序），用于缓存指纹，保证同一参数永远同一指纹。 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) return '[circular]'
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(walk)
    const obj = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) out[key] = walk(obj[key])
    return out
  }
  return JSON.stringify(walk(value))
}

export function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  )
}

export function bytesText(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return Math.round(n / 1024) + ' KB'
}
