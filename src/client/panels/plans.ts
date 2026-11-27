/**
 * Plan 面板：列出落盘 plan，并把每个镜头"可直接预览的 fileKey"排成网格（P1-4）。
 * 数据按需拉取（打开这个 tab 才请求），拉取失败只影响本面板，不污染全局 connect 槽。
 */
import * as React from 'react'
import { h } from '../h.js'
import { Alert, Badge, Btn, Card, MediaTile, fileKindOf } from '../components.js'
import { explainError, fetchPlan, fetchPlans, type PlanPreviewShot, type PlanRow } from '../api.js'
import type { PanelProps } from '../panel-types.js'

export function PlansPanel(props: PanelProps): React.ReactElement {
  const { actions, now } = props
  const [rows, setRows] = React.useState<PlanRow[]>([])
  const [openId, setOpenId] = React.useState<string | undefined>(undefined)
  const [preview, setPreview] = React.useState<PlanPreviewShot[]>([])
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback((signal: AbortSignal) => {
    setLoading(true)
    fetchPlans(signal)
      .then((plans) => {
        setRows(plans)
        setError(undefined)
      })
      .catch((err: unknown) => {
        if (signal.aborted) return
        setError(explainError(err, 'connect').title)
      })
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const open = (planId: string): void => {
    setOpenId(planId)
    const controller = new AbortController()
    fetchPlan(planId, controller.signal)
      .then(result => setPreview(result.preview))
      .catch((err: unknown) => setError(explainError(err, 'connect').title))
  }

  const list = h('div', { className: 'vf-col', style: { gap: 6 } },
    error !== undefined ? Alert({ tone: 'danger', title: '读取 plan 失败', hint: error }) : null,
    rows.length === 0
      ? h('div', { className: 'vf-muted', style: { fontSize: 11.5 } }, loading ? '读取中…' : '还没有落盘的 plan（生成一次并勾选 writePlan）。')
      : rows.slice(0, 20).map(row => h('button', {
        key: row.planId,
        type: 'button',
        className: 'vf-card',
        onClick: () => open(row.planId),
        style: {
          textAlign: 'left', cursor: 'pointer', font: 'inherit',
          borderColor: openId === row.planId ? 'var(--vf-accent)' : 'var(--vf-border)',
        },
      },
      h('div', { className: 'vf-row', style: { justifyContent: 'space-between', gap: 6 } },
        h('span', { style: { fontSize: 12, fontWeight: 600 } }, row.title || row.planId),
        Badge({ tone: 'plain', children: row.shots + ' 镜 · ' + row.frames + ' 帧' })),
      h('div', { className: 'vf-muted vf-mono', style: { fontSize: 9.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.planId))))

  const current = rows.find(row => row.planId === openId)
  const tiles = (openId !== undefined && preview.length > 0 ? preview : current?.preview ?? [])

  const detail = h('div', { className: 'vf-col', style: { gap: 8 } },
    openId === undefined
      ? h('div', { className: 'vf-muted', style: { fontSize: 11.5 } }, '选择左侧 plan 查看逐镜预览。')
      : h('div', { className: 'vf-col', style: { gap: 8 } },
        h('div', { className: 'vf-row', style: { justifyContent: 'space-between' } },
          h('span', { className: 'vf-mono', style: { fontSize: 10.5 } }, openId),
          h('div', { className: 'vf-row', style: { gap: 4 } },
            current !== undefined ? h('span', { className: 'vf-muted', style: { fontSize: 10 } }, new Date(current.modified).toLocaleString()) : null,
            Btn({ label: '刷新', onClick: () => open(openId) }))),
        tiles.length === 0
          ? h('div', { className: 'vf-muted', style: { fontSize: 11 } }, '这个 plan 还没有产物 fileKey（可能未生成完）。')
          : tiles.map(shot => h('div', { key: shot.id, className: 'vf-card', style: { padding: 8 } },
            h('div', { className: 'vf-row', style: { justifyContent: 'space-between', marginBottom: 4 } },
              h('span', { style: { fontSize: 11.5, fontWeight: 600 } }, '#' + (shot.index + 1) + ' ' + shot.id),
              h('div', { className: 'vf-row', style: { gap: 4 } },
                Badge({ tone: shot.strategy.startsWith('magi2') ? 'accent' : 'plain', children: shot.strategy }),
                h('span', { className: 'vf-muted', style: { fontSize: 10 } }, '帧 ' + shot.from + '–' + (shot.from + shot.durationInFrames)))),
            shot.caption !== undefined ? h('div', { className: 'vf-muted', style: { fontSize: 10.5, marginBottom: 4 } }, shot.caption) : null,
            h('div', { className: 'vf-grid' }, ['still', 'plate', 'depth', 'matte', 'video'].map((role) => {
              const fileKey = shot.fileKeys[role]
              return h('div', { key: role, className: 'vf-col', style: { gap: 3 } },
                MediaTile({
                  media: fileKey === undefined ? undefined : { fileKey, kind: fileKindOf(fileKey) === 'video' ? 'video' : 'image', label: role },
                  emptyText: role + ' 无产物',
                  onOpen: actions.openLightbox,
                }),
                h('div', { className: 'vf-muted', style: { fontSize: 9.5 } }, role))
            })))))) 

  return h('div', { className: 'vf-grid' },
    Card({ title: 'Plan 列表', actions: h('span', { className: 'vf-muted', style: { fontSize: 10 } }, now > 0 ? '' : '') , children: list }),
    Card({ title: '逐镜预览', children: detail }))
}
