/**
 * 作业面板：增量事件流（P1-1）、真取消（P1-2）、精准锁定（P1-9 的消费端）、
 * 快照重跑（P0-1）、pending_quota 三态处理、Mock 斜纹（P0-4）、产物灯箱（P1-5）。
 */
import * as React from 'react'
import { h } from '../h.js'
import { Alert, Badge, Btn, Card, MediaTile, Progress, StripeWarning, ago, bytesText, fileKindOf } from '../components.js'
import type { JobLite } from '../api.js'
import type { PanelProps } from '../panel-types.js'

const STATUS_LABEL: Record<JobLite['status'], string> = {
  running: '进行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  pending_quota: '待官方配额',
}

const STATUS_TONE: Record<JobLite['status'], 'ok' | 'warn' | 'danger' | 'accent' | 'plain'> = {
  running: 'accent',
  done: 'ok',
  failed: 'danger',
  cancelled: 'plain',
  pending_quota: 'warn',
}

function jobTitle(job: JobLite): string {
  return (job.mock ? '[MOCK] ' : '') + (job.title || job.planId || job.id)
}

/** 取消语义说明：远端不回收，是本轮已知的计费风险，必须让用户看得见。 */
function cancelNote(): React.ReactElement {
  return Alert({
    tone: 'info',
    title: '关于「取消」的边界',
    hint: '取消会立刻中止本机的排队、轮询与下载，作业状态置为 cancelled。但 Sand.ai / MiniMax 均未提供对外取消接口，已经提交到远端的生成任务可能继续运行并计费。',
    detail: '远端 taskId 保留在作业记录里，可用于对账；本仓不会因此重试或重复计费。',
  })
}

export function JobsPanel(props: PanelProps): React.ReactElement {
  const { state, actions, now, busy } = props
  const [selectedId, setSelectedId] = React.useState<string | undefined>(state.activeJobId)

  React.useEffect(() => {
    if (state.activeJobId !== undefined) setSelectedId(state.activeJobId)
  }, [state.activeJobId])

  const selected = selectedId === undefined
    ? state.jobs[0]
    : state.jobs.find(job => job.id === selectedId) ?? state.jobs[0]
  const stream = selected === undefined ? undefined : state.streams[selected.id]

  const list = h('div', { className: 'vf-col', style: { gap: 6 } },
    state.jobs.length === 0
      ? h('div', { className: 'vf-muted', style: { fontSize: 11.5 } }, '还没有作业。左边填好分镜点「生成」。')
      : state.jobs.slice(0, 12).map(job => h('button', {
        key: job.id,
        type: 'button',
        className: 'vf-card',
        'aria-current': selected?.id === job.id,
        onClick: () => setSelectedId(job.id),
        style: {
          textAlign: 'left', cursor: 'pointer', font: 'inherit',
          borderColor: selected?.id === job.id ? 'var(--vf-accent)' : 'var(--vf-border)',
          background: job.mock ? 'var(--vf-mock-a)' : 'var(--vf-bg-soft)',
        },
      },
      h('div', { className: 'vf-row', style: { justifyContent: 'space-between', gap: 6 } },
        h('span', { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, jobTitle(job)),
        Badge({ tone: STATUS_TONE[job.status], children: STATUS_LABEL[job.status] })),
      h('div', { className: 'vf-row', style: { justifyContent: 'space-between', marginTop: 4 } },
        h('span', { className: 'vf-muted', style: { fontSize: 10.5 } }, ago(job.startedAt, now) + ' · ' + job.progress.done + '/' + job.progress.total),
        job.requestSnapshot !== undefined ? h('span', { className: 'vf-muted', style: { fontSize: 10 } }, '可重跑') : null),
      h('div', { style: { marginTop: 6 } }, Progress({ done: job.progress.done, total: job.progress.total })))))

  const detail = selected === undefined ? h('div', { className: 'vf-muted', style: { fontSize: 11.5 } }, '选择左侧作业查看细节。') : h('div', { className: 'vf-col', style: { gap: 8 } },
    h('div', { className: 'vf-row', style: { justifyContent: 'space-between', gap: 6 } },
      h('div', { className: 'vf-row', style: { gap: 6 } },
        Badge({ tone: STATUS_TONE[selected.status], children: STATUS_LABEL[selected.status] }),
        selected.mock ? Badge({ tone: 'warn', children: 'MOCK' }) : null,
        selected.dryRun ? Badge({ tone: 'plain', children: 'DRY RUN' }) : null,
        h('span', { className: 'vf-mono', style: { fontSize: 10.5 } }, selected.id)),
      h('div', { className: 'vf-row', style: { gap: 4 } },
        // P1-2：真取消
        selected.cancelable
          ? Btn({
              label: '取消',
              variant: 'danger',
              disabled: busy,
              onClick: () => actions.cancel(selected.id),
              // 取消的是本地这条链路，不是远端已提交的生成任务：
              // 官方没有对外暴露任务取消接口，远端可能继续跑并计费，必须说清楚。
              title: '取消只中止本机的排队、轮询与下载；已提交到 Provider 的任务官方未提供取消接口，可能继续计费',
              ariaLabel: '取消作业（仅中止本机链路，远端可能继续计费）',
            })
          : null,
        // P0-1：快照重跑 / 载入表单
        selected.requestSnapshot !== undefined
          ? Btn({ label: '按原参数重跑', disabled: busy, onClick: () => actions.rerunExact(selected.id), title: '严格使用 job.requestSnapshot，不受当前表单影响' })
          : null,
        selected.requestSnapshot !== undefined
          ? Btn({ label: '载入当前表单编辑', disabled: busy, onClick: () => actions.loadSnapshot(selected.id) })
          : null,
        selected.status === 'pending_quota'
          ? Btn({ label: '一键重放', variant: 'primary', disabled: busy, onClick: () => actions.replay(selected.id) })
          : null)),

    selected.status === 'pending_quota'
      ? Alert({
        tone: 'warn',
        title: '官方配额未下发（已鉴权）',
        hint: 'Sand.ai 返回 400 insufficient_credits：Key 与参数都已校验通过，配额到位后点「一键重放」即可，无需改代码。也可以先「改用 MiniMax H3 生成」出片。',
        detail: selected.pendingQuota?.error ?? selected.error,
        actions: Btn({ label: '改用 MiniMax H3', onClick: () => actions.loadSnapshot(selected.id) }),
      })
      : null,
    selected.error !== undefined && selected.status !== 'pending_quota'
      ? Alert({ tone: 'danger', title: '作业失败', hint: selected.error.split('\n')[0] ?? '', detail: selected.error })
      : null,
    selected.mock ? StripeWarning({ text: 'Mock 产物：占位资产，不可作为正式成片' }) : null,
    // P1-3：取消的边界（远端不回收）—— 只有作业还在跑或等配额时才提示，避免噪音
    selected.cancelable || selected.status === 'pending_quota' ? cancelNote() : null,

    h('div', { className: 'vf-row', style: { justifyContent: 'space-between', fontSize: 11 } },
      h('span', { className: 'vf-muted' }, selected.progress.label === '' ? '—' : selected.progress.label),
      h('span', { className: 'vf-mono' }, selected.progress.done + '/' + selected.progress.total)),
    Progress({ done: selected.progress.done, total: selected.progress.total }),

    // 事件流（增量拉取，P1-1）
    Card({
      title: '事件流' + (stream === undefined ? '' : ' · ' + stream.events.length + ' 条'),
      children: h('div', { className: 'vf-scroll' },
        stream === undefined || stream.events.length === 0
          ? h('div', { className: 'vf-muted', style: { fontSize: 11 } }, '暂无事件')
          : stream.events.slice(-120).map((event, index) => h('div', {
            key: index,
            style: {
              display: 'grid', gridTemplateColumns: '58px 1fr', gap: 8,
              fontSize: 10.8, padding: '1px 0',
              color: event.type === 'error' ? 'var(--vf-danger)' : event.type === 'done' ? 'var(--vf-ok)' : 'var(--vf-text-dim)',
            },
          },
          h('span', { className: 'vf-mono' }, event.provider === '*' ? 'job' : event.provider),
          h('span', null, (event.taskId === '*' ? '' : event.taskId + ' · ') + (event.message ?? event.type))))),
    }),

    // 产物
    Card({
      title: '产物',
      actions: selected.planPath !== undefined ? h('span', { className: 'vf-muted', style: { fontSize: 10 } }, 'plan 已落盘') : null,
      children: selected.results.length === 0
        ? h('div', { className: 'vf-muted', style: { fontSize: 11 } }, '还没有产物')
        : h('div', { className: 'vf-col', style: { gap: 8 } }, selected.results.filter(result => result.artifacts.length > 0 || result.error !== undefined).map(result => h('div', { key: result.id, className: 'vf-col', style: { gap: 4 } },
          h('div', { className: 'vf-row', style: { gap: 6, fontSize: 11 } },
            Badge({ tone: result.ok ? 'ok' : 'danger', children: result.provider }),
            h('span', { className: 'vf-mono' }, result.id),
            result.cached ? Badge({ tone: 'plain', children: '缓存命中' }) : null,
            h('span', { className: 'vf-muted' }, result.seconds.toFixed(1) + 's')),
          result.error !== undefined ? h('div', { style: { fontSize: 10.5, color: 'var(--vf-danger)' } }, result.error) : null,
          h('div', { className: 'vf-grid' }, result.artifacts.map(artifact => h('div', { key: artifact.id, className: 'vf-col', style: { gap: 3 } },
            MediaTile({
              media: { fileKey: artifact.fileKey, kind: fileKindOf(artifact.fileKey) === 'video' ? 'video' : 'image', label: artifact.fileKey },
              onOpen: actions.openLightbox,
            }),
            h('div', { className: 'vf-muted vf-mono', style: { fontSize: 9.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              artifact.fileKey.split('/').slice(-1)[0] + ' · ' + bytesText(artifact.bytes)),
            artifact.meta?.['hasAudio'] === false ? h('div', { className: 'vf-muted', style: { fontSize: 9.5 } }, '无音轨（hasAudio=false）') : null))))))
    }))

  return h('div', { className: 'vf-grid' },
    Card({ title: '作业列表', children: list }),
    Card({ title: '作业细节', children: detail }))
}
