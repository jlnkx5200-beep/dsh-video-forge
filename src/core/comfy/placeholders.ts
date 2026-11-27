/**
 * 工作流参数注入（Placeholder Injection）—— TS 侧实现。
 *
 * 语法与 ComfyUI 侧 `comfyui-nodes/dsh_video_assets/placeholders.py` **完全一致**，
 * 两侧共用同一份契约夹具 `fixtures/placeholder-scope.json`（templates 原样 + 期望输出）。
 *
 *   ${a.b.c}          点路径取值
 *   ${VAR:fallback}   取不到时用 fallback（fallback 内不允许再嵌套 ${}）
 *   \${...}           转义：输出字面量 ${...}
 *   非字符串原样返回；纯占位符字符串保留原类型（数字/布尔/对象/数组不被字符串化）
 */
export type PlaceholderScope = Record<string, unknown>

export class PlaceholderError extends Error {
  constructor(message: string, readonly path: string) {
    super(message)
    this.name = 'PlaceholderError'
  }
}

const PLACEHOLDER = /\\?\$\{([^{}]*)\}/g

function lookup(scope: PlaceholderScope, dotted: string): { found: boolean; value: unknown } {
  const parts = dotted.split('.').map(p => p.trim()).filter(p => p !== '')
  let cursor: unknown = scope
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return { found: false, value: undefined }
    const record = cursor as Record<string, unknown>
    if (!(part in record)) return { found: false, value: undefined }
    cursor = record[part]
  }
  if (cursor === undefined) return { found: false, value: undefined }
  return { found: true, value: cursor }
}

/** 解析单个字符串；strict 下未解析且无 fallback 的占位符抛 PlaceholderError。 */
export function resolveString(input: string, scope: PlaceholderScope, options: { strict?: boolean } = {}): unknown {
  const matches = [...input.matchAll(PLACEHOLDER)]
  if (matches.length === 0) return input

  // 整串就是一个占位符 → 保留原类型
  const whole = matches.length === 1 && matches[0]![0] === input
  if (whole) {
    const token = matches[0]![0]
    if (token.startsWith('\\')) return token.slice(1)
    const body = matches[0]![1] ?? ''
    const { key, fallback } = splitFallback(body)
    const hit = lookup(scope, key)
    if (hit.found) return hit.value
    if (fallback !== undefined) return fallback
    if (options.strict === true) throw new PlaceholderError('未解析的占位符：${' + body + '}', key)
    return input
  }

  let out = ''
  let last = 0
  for (const match of matches) {
    const index = match.index ?? 0
    out += input.slice(last, index)
    last = index + match[0].length
    const token = match[0]
    if (token.startsWith('\\')) {
      out += token.slice(1)
      continue
    }
    const body = match[1] ?? ''
    const { key, fallback } = splitFallback(body)
    const hit = lookup(scope, key)
    if (hit.found) {
      out += typeof hit.value === 'object' && hit.value !== null ? JSON.stringify(hit.value) : String(hit.value)
      continue
    }
    if (fallback !== undefined) {
      out += fallback
      continue
    }
    if (options.strict === true) throw new PlaceholderError('未解析的占位符：${' + body + '}', key)
    out += token
  }
  out += input.slice(last)
  return out
}

function splitFallback(body: string): { key: string; fallback?: string } {
  const idx = body.indexOf(':')
  if (idx < 0) return { key: body.trim() }
  return { key: body.slice(0, idx).trim(), fallback: body.slice(idx + 1) }
}

/** 递归注入到任意 JSON 值（对象/数组/字符串）。不改动入参，返回新结构。 */
export function resolvePlaceholders<T>(value: T, scope: PlaceholderScope, options: { strict?: boolean } = {}): T {
  if (typeof value === 'string') return resolveString(value, scope, options) as unknown as T
  if (Array.isArray(value)) return value.map(item => resolvePlaceholders(item, scope, options)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolvePlaceholders(item, scope, options)
    }
    return out as unknown as T
  }
  return value
}

/** 从工作流里扫出所有被引用的点路径（面板「需要绑定的参数」清单就用它）。 */
export function collectPlaceholderPaths(workflow: unknown): string[] {
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER)) {
        if (match[0].startsWith('\\')) continue
        const { key } = splitFallback(match[1] ?? '')
        if (key !== '') found.add(key)
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (value !== null && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk)
    }
  }
  walk(workflow)
  return [...found].sort()
}
