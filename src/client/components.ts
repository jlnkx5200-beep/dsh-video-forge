/**
 * UI 原语。全部用 `h()`（无 JSX），全部走 CSS 变量（无 hex），全部带 ARIA。
 *
 * 这里还坐了 P1-8 的"全局单路视频解码锁"：面板里可能有十几段 H3 / MAGI-2 产物，
 * 同时解码会把 GPU/CPU 拖死，所以同一时刻只允许一个 <video> 播，其余自动暂停。
 */
import * as React from 'react'
import { h } from './h.js'
import { fileUrl } from './api.js'

// ── 单路视频解码锁（P1-8） ────────────────────────────────────────────────
let playing: HTMLVideoElement | null = null

export function claimVideo(el: HTMLVideoElement): void {
  if (playing !== null && playing !== el) {
    try {
      playing.pause()
      playing.currentTime = 0
    } catch {
      /* 元素可能已卸载，忽略 */
    }
  }
  playing = el
}

export function releaseVideo(el: HTMLVideoElement): void {
  if (playing === el) playing = null
}

export function resetVideoLock(): void {
  if (playing !== null) {
    try {
      playing.pause()
    } catch {
      /* ignore */
    }
  }
  playing = null
}

// ── 基础件 ────────────────────────────────────────────────────────────────
export function Card(props: { title?: string; actions?: React.ReactNode; className?: string; children?: React.ReactNode; style?: React.CSSProperties }): React.ReactElement {
  return h('section', { className: ['vf-card', props.className ?? ''].filter(Boolean).join(' ') },
    (props.title !== undefined || props.actions !== undefined)
      ? h('div', { className: 'vf-row', style: { justifyContent: 'space-between', marginBottom: 8 } },
        h('div', { className: 'vf-card-title' }, props.title ?? ''),
        props.actions ?? null)
      : null,
    props.children ?? null)
}

type BtnVariant = 'default' | 'primary' | 'danger'

export function Btn(props: { label: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: BtnVariant; title?: string; ariaLabel?: string }): React.ReactElement {
  const variant = props.variant ?? 'default'
  return h('button', {
    type: 'button',
    className: 'vf-btn' + (variant === 'primary' ? ' vf-btn-primary' : variant === 'danger' ? ' vf-btn-danger' : ''),
    onClick: props.onClick,
    disabled: props.disabled === true,
    title: props.title,
    'aria-label': props.ariaLabel ?? (typeof props.label === 'string' ? props.label : undefined),
  }, props.label)
}

export function Field(props: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }): React.ReactElement {
  return h('label', { className: 'vf-col', style: { gap: 3 } },
    h('span', { className: 'vf-muted', style: { fontSize: 11 } }, props.label),
    props.children,
    props.hint !== undefined ? h('span', { className: 'vf-muted', style: { fontSize: 10 } }, props.hint) : null)
}

export function TextInput(props: { value: string; onChange: (value: string) => void; placeholder?: string; ariaLabel?: string; mono?: boolean; disabled?: boolean }): React.ReactElement {
  return h('input', {
    className: 'vf-input' + (props.mono === true ? ' vf-mono' : ''),
    value: props.value,
    placeholder: props.placeholder,
    'aria-label': props.ariaLabel,
    disabled: props.disabled === true,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value),
  })
}

export function TextArea(props: { value: string; onChange: (value: string) => void; rows?: number; ariaLabel?: string; placeholder?: string; mono?: boolean }): React.ReactElement {
  return h('textarea', {
    className: 'vf-textarea' + (props.mono === true ? '' : ''),
    value: props.value,
    rows: props.rows ?? 8,
    'aria-label': props.ariaLabel,
    placeholder: props.placeholder,
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.target.value),
  })
}

export function Select(props: { value: string; options: readonly string[]; onChange: (value: string) => void; ariaLabel?: string; labels?: Record<string, string> }): React.ReactElement {
  return h('select', {
    className: 'vf-select',
    value: props.value,
    'aria-label': props.ariaLabel,
    onChange: (event: React.ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value),
  }, props.options.map(option => h('option', { key: option, value: option }, props.labels?.[option] ?? option)))
}

export function Check(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string; disabled?: boolean }): React.ReactElement {
  return h('label', { className: 'vf-row', style: { gap: 6, cursor: props.disabled === true ? 'not-allowed' : 'pointer', alignItems: 'flex-start' } },
    h('input', {
      type: 'checkbox',
      checked: props.checked,
      disabled: props.disabled === true,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => props.onChange(event.target.checked),
      style: { marginTop: 2 },
    }),
    h('span', { className: 'vf-col', style: { gap: 0 } },
      h('span', { style: { fontSize: 12 } }, props.label),
      props.hint !== undefined ? h('span', { className: 'vf-muted', style: { fontSize: 10 } }, props.hint) : null))
}

export function Badge(props: { tone?: 'ok' | 'warn' | 'danger' | 'accent' | 'plain'; children: React.ReactNode }): React.ReactElement {
  const tone = props.tone ?? 'plain'
  return h('span', { className: 'vf-badge' + (tone === 'plain' ? '' : ' vf-badge-' + tone) }, props.children)
}

export function Alert(props: { tone: 'ok' | 'warn' | 'danger' | 'info'; title: string; hint?: string; detail?: string; actions?: React.ReactNode }): React.ReactElement {
  return h('div', { className: 'vf-alert vf-alert-' + props.tone, role: props.tone === 'danger' ? 'alert' : 'status' },
    h('div', { className: 'vf-col', style: { gap: 2, flex: 1 } },
      h('div', { className: 'vf-alert-title' }, props.title),
      props.hint !== undefined ? h('div', { style: { fontSize: 11.5 } }, props.hint) : null,
      props.detail !== undefined && props.detail !== ''
        ? h('details', { className: 'vf-details' },
          h('summary', null, '技术细节'),
          h('div', { className: 'vf-code' }, props.detail))
        : null),
    props.actions ?? null)
}

export function Tabs(props: { items: Array<{ id: string; label: string }>; value: string; onChange: (id: string) => void }): React.ReactElement {
  return h('div', { className: 'vf-tabs', role: 'tablist', 'aria-label': 'Video Forge 视图' },
    props.items.map(item => h('button', {
      key: item.id,
      type: 'button',
      role: 'tab',
      id: 'vf-tab-' + item.id,
      'aria-selected': props.value === item.id,
      'aria-controls': 'vf-panel-' + item.id,
      tabIndex: props.value === item.id ? 0 : -1,
      className: 'vf-tab',
      onClick: () => props.onChange(item.id),
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        const index = props.items.findIndex(candidate => candidate.id === props.value)
        const delta = event.key === 'ArrowRight' ? 1 : -1
        const next = props.items[(index + delta + props.items.length) % props.items.length]
        if (next !== undefined) props.onChange(next.id)
      },
    }, item.label)))
}

export function TabPanel(props: { id: string; active: boolean; children: React.ReactNode }): React.ReactElement {
  return h('div', {
    id: 'vf-panel-' + props.id,
    role: 'tabpanel',
    'aria-labelledby': 'vf-tab-' + props.id,
    hidden: !props.active,
    className: 'vf-col',
    style: { gap: 10 },
  }, props.active ? props.children : null)
}

/** Mock 模式的琥珀斜纹警示（P0-4）。 */
export function StripeWarning(props: { text?: string }): React.ReactElement {
  return h('div', { className: 'vf-mock-stripes', style: { borderRadius: 8, padding: '6px 10px', fontSize: 11.5 }, role: 'note' },
    props.text ?? '占位资产，不可作为正式成片')
}

export function Progress(props: { done: number; total: number }): React.ReactElement {
  const pct = props.total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((props.done / props.total) * 100)))
  return h('div', { className: 'vf-progress', role: 'progressbar', 'aria-valuenow': props.done, 'aria-valuemin': 0, 'aria-valuemax': props.total, 'aria-label': '任务进度' },
    h('i', { style: { width: pct + '%' } }))
}

export function Kv(props: { rows: Array<[string, React.ReactNode]> }): React.ReactElement {
  const children: React.ReactNode[] = []
  props.rows.forEach((row, index) => {
    children.push(h('span', { key: 'k' + index }, row[0]))
    children.push(h('span', { key: 'v' + index, className: 'vf-mono' }, row[1]))
  })
  return h('div', { className: 'vf-kv' }, children)
}

// ── 媒体与灯箱（P1-4 / P1-5） ─────────────────────────────────────────────
export interface MediaRef {
  fileKey: string
  kind: 'image' | 'video' | 'other'
  label?: string
}

export function mediaUrl(fileKey: string): string {
  return fileUrl(fileKey)
}

export function Lightbox(props: { media: MediaRef; onClose: () => void }): React.ReactElement {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  const url = mediaUrl(props.media.fileKey)
  const copy = (): void => {
    void navigator.clipboard?.writeText(props.media.fileKey).catch(() => undefined)
  }
  return h('div', {
    className: 'vf-lightbox',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '资产预览：' + (props.media.label ?? props.media.fileKey),
    onClick: props.onClose,
  }, h('div', { className: 'vf-lightbox-inner', onClick: (event: React.MouseEvent) => event.stopPropagation() },
    props.media.kind === 'video'
      ? h('video', { className: 'vf-lightbox-media', src: url, controls: true, autoPlay: true, onPlay: (event: React.SyntheticEvent<HTMLVideoElement>) => claimVideo(event.currentTarget) })
      : h('img', { className: 'vf-lightbox-media', src: url, alt: props.media.label ?? '资产预览' }),
    h('div', { className: 'vf-lightbox-bar' },
      h('span', { className: 'vf-mono' }, props.media.fileKey),
      h('a', { className: 'vf-btn', href: url, download: '', style: { textDecoration: 'none' } }, '下载'),
      h('button', { type: 'button', className: 'vf-btn', onClick: copy }, '复制路径'),
      h('button', { type: 'button', className: 'vf-btn', onClick: props.onClose }, '关闭'))))
}

export function MediaTile(props: { media?: MediaRef; emptyText?: string; onOpen: (media: MediaRef) => void }): React.ReactElement {
  if (props.media === undefined) {
    return h('div', { className: 'vf-thumb vf-thumb-empty' }, props.emptyText ?? '无产物')
  }
  const url = mediaUrl(props.media.fileKey)
  return props.media.kind === 'video'
    ? h('video', {
      className: 'vf-thumb',
      src: url,
      muted: true,
      controls: true,
      preload: 'metadata',
      onPlay: (event: React.SyntheticEvent<HTMLVideoElement>) => claimVideo(event.currentTarget),
      onPause: (event: React.SyntheticEvent<HTMLVideoElement>) => releaseVideo(event.currentTarget),
    })
    : h('img', { className: 'vf-thumb', src: url, alt: props.media.label ?? props.media.fileKey, onClick: () => props.onOpen(props.media as MediaRef) })
}

export function fileKindOf(fileKey: string | undefined): 'image' | 'video' | 'other' {
  if (fileKey === undefined) return 'other'
  if (/\.(png|jpe?g|webp|gif)$/i.test(fileKey)) return 'image'
  if (/\.(mp4|webm|mov)$/i.test(fileKey)) return 'video'
  return 'other'
}

export function bytesText(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

export function ago(at: number, now: number): string {
  if (at <= 0) return '—'
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 60) return sec + 's 前'
  if (sec < 3600) return Math.round(sec / 60) + 'min 前'
  return Math.round(sec / 3600) + 'h 前'
}
