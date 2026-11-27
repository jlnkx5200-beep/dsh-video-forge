/**
 * 极小的元素工厂：本插件所有客户端文件都是 `.ts`（tsconfig 无 jsx），
 * 因此统一用 `h()` 而不是 JSX。children 会自动摊平并丢掉 null/false。
 */
import * as React from 'react'

type Child = React.ReactNode

export function h(tag: unknown, props?: Record<string, unknown> | null, ...children: Array<Child | Child[]>): React.ReactElement {
  const flat: Child[] = []
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...child)
    else flat.push(child as Child)
  }
  return React.createElement(tag as never, (props ?? {}) as never, ...flat)
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(part => typeof part === 'string' && part !== '').join(' ')
}
