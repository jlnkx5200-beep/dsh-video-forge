/**
 * 内容寻址缓存池（防重复扣费 / 防重复渲染）。
 *
 * 指纹 = sha256(canonicalJson({ provider, kind, params(去掉易变项), inputs, workflowHash, extra }))
 * 布局 = <cacheDir>/<fp[0:2]>/<fp>/manifest.json + 产物副本
 *
 * Debug Remotion 时间轴时的正确姿势：mock / dryRun 打开 → 零网络请求。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { canonicalJson } from './http.js'
import type { Artifact, AssetIndexLike, CacheEntry, CacheLike, MediaKind, TaskRequest, TaskResult } from './providers/types.js'
import { artifactUrl } from './providers/types.js'

/** 这些参数只影响"放哪/等多久"，不影响产物内容，不能进指纹。 */
const VOLATILE_KEYS = new Set([
  'outDir', 'callback_url', 'callbackUrl', 'timeoutMs', 'timeoutSec', 'pollMs',
  'savePath', 'client_id', 'clientId', 'verbose', 'dryRun', 'mock', 'force',
])

function stripVolatile(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (VOLATILE_KEYS.has(key)) continue
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

export class ForgeCache implements CacheLike {
  constructor(private readonly root: string) {}

  fingerprint(request: TaskRequest, extra: Record<string, unknown> = {}): string {
    const payload = {
      provider: request.provider,
      kind: request.kind,
      params: stripVolatile(request.params),
      inputs: (request.inputs ?? []).map(i => ({ role: i.role, artifactId: i.artifactId ?? null, path: i.path ?? null, url: i.url ?? null })),
      ...extra,
    }
    return createHash('sha256').update(canonicalJson(payload)).digest('hex')
  }

  dirOf(fingerprint: string): string {
    return join(this.root, fingerprint.slice(0, 2), fingerprint)
  }

  private manifestPath(fingerprint: string): string {
    return join(this.dirOf(fingerprint), 'manifest.json')
  }

  read(fingerprint: string): CacheEntry | null {
    const manifest = this.manifestPath(fingerprint)
    if (!existsSync(manifest)) return null
    try {
      const entry = JSON.parse(readFileSync(manifest, 'utf8')) as CacheEntry
      if (!Array.isArray(entry.files)) return null
      for (const file of entry.files) {
        if (!existsSync(file.path)) return null
      }
      return entry
    } catch {
      return null
    }
  }

  write(fingerprint: string, result: TaskResult, files: Array<{ path: string; name: string }>): CacheEntry | null {
    if (files.length === 0) return null
    const dir = this.dirOf(fingerprint)
    mkdirSync(dir, { recursive: true })
    const stored: CacheEntry['files'] = []
    for (const file of files) {
      if (!existsSync(file.path)) continue
      const name = basename(file.name)
      const target = join(dir, name)
      if (file.path !== target) copyFileSync(file.path, target)
      stored.push({
        fileKey: 'c/' + fingerprint.slice(0, 2) + '/' + fingerprint + '/' + name,
        path: target,
        bytes: statSync(target).size,
        name,
      })
    }
    if (stored.length === 0) return null
    const entry: CacheEntry = {
      fingerprint,
      files: stored,
      meta: {
        provider: result.provider,
        taskId: result.taskId,
        seconds: result.seconds,
        usage: result.usage ?? {},
        warnings: result.warnings,
        artifacts: result.artifacts.map(a => ({ id: a.id, kind: a.kind, width: a.width, height: a.height, durationSec: a.durationSec, meta: a.meta ?? {} })),
      },
      createdAt: Date.now(),
    }
    writeFileSync(this.manifestPath(fingerprint), JSON.stringify(entry, null, 2), 'utf8')
    return entry
  }

  artifacts(entry: CacheEntry): Artifact[] {
    const source = Array.isArray(entry.meta.artifacts) ? (entry.meta.artifacts as Array<Record<string, unknown>>) : []
    return entry.files.map((file, index) => {
      const meta = source[index] ?? {}
      const ext = file.name.toLowerCase()
      const kind: MediaKind = ext.endsWith('.mp4') || ext.endsWith('.webm') || ext.endsWith('.mov') ? 'video' : 'image'
      return {
        id: typeof meta.id === 'string' ? meta.id : file.name,
        kind: (typeof meta.kind === 'string' ? meta.kind : kind) as MediaKind,
        path: file.path,
        url: artifactUrl(file.fileKey),
        fileKey: file.fileKey,
        bytes: file.bytes,
        width: typeof meta.width === 'number' ? meta.width : undefined,
        height: typeof meta.height === 'number' ? meta.height : undefined,
        durationSec: typeof meta.durationSec === 'number' ? meta.durationSec : undefined,
        meta: (meta.meta as Record<string, unknown> | undefined) ?? {},
      }
    })
  }

  stats(): { entries: number; bytes: number } {
    let entries = 0
    let bytes = 0
    const walk = (dir: string): void => {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        const path = join(dir, name)
        let st
        try {
          st = statSync(path)
        } catch {
          continue
        }
        if (st.isDirectory()) walk(path)
        else if (name !== 'manifest.json') {
          entries += 1
          bytes += st.size
        }
      }
    }
    walk(this.root)
    return { entries, bytes }
  }

  /**
   * Provider 外部资源索引（例：Sand.ai 的 SHA256 → assetId）。
   * 放在 `<cacheDir>/_assets/<name>.json`，与产物缓存同一棵树：
   * 统计走同一套 walk，GC 有统一入口，换机器清缓存时不会漏掉这一份。
   */
  assetIndex(name: string): AssetIndexLike {
    const safe = name.replace(/[^\w.-]+/g, '_')
    const path = join(this.root, '_assets', safe + '.json')
    const read = (): Record<string, unknown> => {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        return parsed as Record<string, unknown>
      } catch {
        return {}
      }
    }
    const write = (map: Record<string, unknown>): void => {
      try {
        mkdirSync(join(this.root, '_assets'), { recursive: true })
        writeFileSync(path, JSON.stringify(map, null, 2) + '\n', 'utf8')
      } catch {
        /* 索引写不进去只影响复用率，不该让生成失败 */
      }
    }
    return {
      read,
      write,
      prune: (exists) => {
        const current = read()
        const kept: Record<string, unknown> = {}
        let removed = 0
        for (const [key, value] of Object.entries(current)) {
          if (exists(key, value)) kept[key] = value
          else removed += 1
        }
        if (removed > 0) write(kept)
        return { removed, kept: Object.keys(kept).length }
      },
    }
  }

  list(limit = 40): Array<{ fingerprint: string; createdAt: number; files: number; provider: string }> {
    const rows: Array<{ fingerprint: string; createdAt: number; files: number; provider: string }> = []
    let buckets: string[] = []
    try {
      buckets = readdirSync(this.root)
    } catch {
      return rows
    }
    for (const bucket of buckets) {
      const bucketDir = join(this.root, bucket)
      let entries: string[] = []
      try {
        if (!statSync(bucketDir).isDirectory()) continue
        entries = readdirSync(bucketDir)
      } catch {
        continue
      }
      for (const fp of entries) {
        try {
          const entry = JSON.parse(readFileSync(join(bucketDir, fp, 'manifest.json'), 'utf8')) as CacheEntry
          rows.push({
            fingerprint: fp,
            createdAt: entry.createdAt ?? 0,
            files: entry.files?.length ?? 0,
            provider: String(entry.meta?.provider ?? ''),
          })
        } catch {
          /* 忽略半截写入 */
        }
      }
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    return rows.slice(0, limit)
  }
}
