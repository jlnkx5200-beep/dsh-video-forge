/**
 * 无损 JSON 化。
 *
 * DSH 的工具返回值必须是「可无损 JSON 化」的普通对象：一旦夹带 `undefined`、
 * Map/Set、NaN、循环引用或 class 实例，宿主会直接判 `value is not lossless JSON`
 * 并把整次调用标成错误（面板上就是一句看不懂的报错）。
 *
 * 所以凡是交给宿主的返回值，一律先过这里：丢掉 undefined / 函数 / symbol，
 * Map→对象、Set/迭代器→数组、Date→ISO、NaN/Infinity→null、循环引用→'[circular]'。
 */

export function jsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value as number) ? value : null
  if (type === 'bigint') return (value as bigint).toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack ?? '' }
  }
  if (typeof value === 'object') {
    const object = value as object
    if (seen.has(object)) return '[circular]'
    seen.add(object)
    try {
      if (Array.isArray(value)) {
        return value.map((item) => {
          const safe = jsonSafe(item, seen)
          return safe === undefined ? null : safe
        })
      }
      if (value instanceof Map) {
        const out: Record<string, unknown> = {}
        for (const [key, item] of value.entries()) {
          const safe = jsonSafe(item, seen)
          if (safe !== undefined) out[String(key)] = safe
        }
        return out
      }
      if (value instanceof Set) {
        return [...value].map((item) => {
          const safe = jsonSafe(item, seen)
          return safe === undefined ? null : safe
        })
      }
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const safe = jsonSafe(item, seen)
        if (safe !== undefined) out[key] = safe
      }
      return out
    } finally {
      seen.delete(object)
    }
  }
  return undefined
}

/** 包一层：确保交给宿主的工具返回值永远是无损 JSON。 */
export function lossless<T>(value: T): Record<string, unknown> {
  const safe = jsonSafe(value)
  return safe !== null && typeof safe === 'object' && !Array.isArray(safe) ? (safe as Record<string, unknown>) : { value: safe ?? null }
}
