/**
 * Video Forge 工作台 —— 面板入口（只做「接线」，不写业务逻辑）。
 *
 * 职责划分：
 *  · `state.ts`          纯状态机（stale 判定 / 错误分槽 / 快照重跑 / 增量事件）
 *  · `api.ts`            端点 + 严格响应校验 + 分槽错误文案
 *  · `shots.ts`          结构化分镜 ⇄ Markdown
 *  · `cost-estimator.ts` 费用相对指数（H3 vs MAGI-2）
 *  · `panels/*`          四个面板（编排 / 作业 / Plan / 设置）
 *  · `theme.ts`          全部颜色与响应式网格（唯一 hex 来源）
 *
 * 这里只负责：定时拉状态、增量拉作业事件、把 Actions 绑到 api、ctx.effect 清理。
 */
import * as React from 'react'
import { h } from './h.js'
import { disposeTheme, injectTheme } from './theme.js'
import {
  Badge, Btn, Lightbox, TabPanel, Tabs,
  type MediaRef,
} from './components.js'
import {
  cancelJob, explainError, fetchJob, fetchJobs, fetchStatus,
  probeMagi2, produce, replayJob, saveConfig,
  type JobDetail,
} from './api.js'
import {
  appendJobEvents, buildProduceBody, clearError, clearNotice,
  formFromSnapshot, initialForm, initialState, isStale, mergeJobs,
  onConnectFail, onProduceAccepted, onStatusOk, setError, setNotice,
  type FormState, type PanelState,
} from './state.js'
import { blankShot, parseMarkdownShots, toMarkdown, toShotPayload, validateShots, type ShotRow } from './shots.js'
import type { Actions, PanelProps } from './panel-types.js'
import { ComposerPanel } from './panels/composer.js'
import { JobsPanel } from './panels/jobs.js'
import { PlansPanel } from './panels/plans.js'
import { SettingsPanel } from './panels/settings.js'

export const inject = ['slots']

const STATUS_POLL_MS = 5000
const JOB_POLL_MS = 1500

type TabId = 'compose' | 'jobs' | 'plans' | 'settings'

/** 从 job.requestSnapshot 直接还原「按原参数重跑」的请求体（P0-1）。 */
function bodyFromSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const storyboard = (snapshot['storyboard'] ?? {}) as Record<string, unknown>
  const options = (snapshot['options'] ?? {}) as Record<string, unknown>
  const body: Record<string, unknown> = {
    title: storyboard['title'],
    width: storyboard['width'],
    height: storyboard['height'],
    fps: storyboard['fps'],
    preset: storyboard['preset'],
    styleTags: storyboard['styleTags'],
    shots: storyboard['shots'],
    // 与 CompileOptions 对齐：一个字段都不许漏，否则「原参数」就是假的
    defaultStrategy: options['defaultStrategy'],
    seedreamModel: options['seedreamModel'],
    minimaxModel: options['minimaxModel'],
    minimaxResolution: options['minimaxResolution'],
    magi2Model: options['magi2Model'],
    magi2Duration: options['magi2Duration'],
    generateAudio: options['generateAudio'],
    qualityMode: options['qualityMode'],
    enablePlate: options['enablePlate'],
    mock: options['mock'],
    dryRun: options['dryRun'],
    useCache: options['useCache'],
    writePlan: true,
  }
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key]
  }
  return body
}

function shotsOf(snapshot: Record<string, unknown> | undefined): ShotRow[] | undefined {
  if (snapshot === undefined) return undefined
  const storyboard = snapshot['storyboard']
  if (storyboard === null || typeof storyboard !== 'object') return undefined
  const raw = (storyboard as Record<string, unknown>)['shots']
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  return raw.map((item, index) => {
    const shot = (item ?? {}) as Record<string, unknown>
    const row = blankShot(index + 1)
    return {
      ...row,
      id: typeof shot['id'] === 'string' ? shot['id'] : row.id,
      prompt: typeof shot['prompt'] === 'string' ? shot['prompt'] : '',
      shot: typeof shot['shot'] === 'string' ? shot['shot'] : row.shot,
      durationSec: typeof shot['durationSec'] === 'number' ? shot['durationSec'] : row.durationSec,
      move: typeof shot['move'] === 'string' ? shot['move'] : row.move,
      transition: typeof shot['transition'] === 'string' ? shot['transition'] : row.transition,
      strategy: typeof shot['strategy'] === 'string' ? shot['strategy'] : '',
      firstFrame: typeof shot['firstFrame'] === 'string' ? shot['firstFrame'] : undefined,
      lastFrame: typeof shot['lastFrame'] === 'string' ? shot['lastFrame'] : undefined,
      generateAudio: typeof shot['generateAudio'] === 'boolean' ? shot['generateAudio'] : undefined,
    }
  })
}

export function VideoForgePanel(): React.ReactElement {
  const [state, setState] = React.useState<PanelState>(initialState)
  const [shots, setShots] = React.useState<ShotRow[]>(() => parseMarkdownShots(initialForm().markdownTable))
  const [busy, setBusy] = React.useState(false)
  const [tab, setTab] = React.useState<TabId>('compose')
  const [lightbox, setLightbox] = React.useState<MediaRef | undefined>(undefined)
  const [now, setNow] = React.useState(() => Date.now())

  const stateRef = React.useRef(state)
  stateRef.current = state
  const shotsRef = React.useRef(shots)
  shotsRef.current = shots
  const busyRef = React.useRef(busy)
  busyRef.current = busy

  // 主题：只在挂载期注入一次，卸载时彻底移除（P2-7 热卸载不留残留）
  React.useEffect(() => {
    injectTheme()
    return () => disposeTheme()
  }, [])

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const apply = React.useCallback((updater: (prev: PanelState) => PanelState) => {
    setState(prev => updater(prev))
  }, [])

  // ── 状态轮询（含 stale 判定）────────────────────────────────────────────
  const refresh = React.useCallback((signal?: AbortSignal) => {
    const at = Date.now()
    fetchStatus(signal)
      .then((status) => {
        apply(prev => onStatusOk(prev, status, at))
        return fetchJobs(6, signal)
      })
      .then((jobs) => apply(prev => mergeJobs(prev, jobs)))
      .catch((error: unknown) => {
        if (signal?.aborted === true) return
        apply(prev => onConnectFail(prev, explainError(error, 'connect'), Date.now()))
      })
  }, [apply])

  React.useEffect(() => {
    const controller = new AbortController()
    refresh(controller.signal)
    const timer = setInterval(() => refresh(controller.signal), STATUS_POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [refresh])

  // ── 作业事件增量拉取（P1-1）：只拉 since 之后的事件 ──────────────────────
  const watchId = state.activeJobId ?? state.jobs.find(job => job.status === 'running')?.id
  React.useEffect(() => {
    if (watchId === undefined) return undefined
    const controller = new AbortController()
    let cancelled = false
    const tick = (): void => {
      const stream = stateRef.current.streams[watchId]
      const since = stream?.cursor ?? 0
      fetchJob(watchId, since, controller.signal)
        .then((detail: JobDetail) => {
          if (cancelled) return
          apply(prev => appendJobEvents(prev, watchId, detail.job, detail.events, detail.cursor))
        })
        .catch(() => { /* 单次事件拉取失败不升级为断连态，下一轮会补上 */ })
    }
    tick()
    const timer = setInterval(tick, JOB_POLL_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [watchId, apply])

  // ── Actions ────────────────────────────────────────────────────────────
  const actions: Actions = React.useMemo(() => {
    const run = async (work: () => Promise<void>): Promise<void> => {
      if (busyRef.current) return
      setBusy(true)
      try {
        await work()
      } finally {
        setBusy(false)
      }
    }

    const submit = (): void => {
      const form = stateRef.current.form
      const rows = shotsRef.current
      const invalid = validateShots(rows)
      if (invalid.length > 0) {
        apply(prev => setError(prev, 'submit', { kind: 'submit', title: '分镜还有问题', hint: invalid[0]?.message ?? '', detail: invalid.map(i => i.message).join('\n') }))
        return
      }
      void run(async () => {
        try {
          const body = buildProduceBody(form, toShotPayload(rows))
          const accepted = await produce(body)
          apply(prev => setNotice(onProduceAccepted(prev, accepted), 'ok', '已提交，作业 ' + accepted.jobId + '（已锁定，不用等轮询）'))
          setTab('jobs')
        } catch (error) {
          apply(prev => setError(prev, 'submit', explainError(error, 'submit')))
        }
      })
    }

    const rerunExact = (jobId: string): void => {
      const job = stateRef.current.jobs.find(item => item.id === jobId)
      const snapshot = job?.requestSnapshot
      if (snapshot === undefined) {
        apply(prev => setError(prev, 'submit', { kind: 'submit', title: '这条作业没有快照', hint: '无法按原参数重跑，请改用「载入当前表单编辑」。', detail: '' }))
        return
      }
      void run(async () => {
        try {
          const accepted = await produce(bodyFromSnapshot(snapshot))
          apply(prev => setNotice(onProduceAccepted(prev, accepted), 'ok', '已按原参数重跑：' + accepted.jobId))
          setTab('jobs')
        } catch (error) {
          apply(prev => setError(prev, 'submit', explainError(error, 'submit')))
        }
      })
    }

    const loadSnapshot = (jobId: string): void => {
      const job = stateRef.current.jobs.find(item => item.id === jobId)
      if (job?.requestSnapshot === undefined) return
      const restored = formFromSnapshot(job.requestSnapshot)
      apply(prev => ({
        ...clearError(prev, 'submit'),
        form: { ...prev.form, ...restored.form },
        notice: {
          tone: restored.missing.length === 0 ? 'ok' : 'warn',
          text: restored.missing.length === 0
            ? '已载入 ' + jobId + ' 的原参数，可编辑后重新提交'
            : '已载入 ' + jobId + '，但这些字段在快照里缺失，未做任何默认：' + restored.missing.join('、'),
        },
      }))
      const rows = shotsOf(job.requestSnapshot)
      if (rows !== undefined) setShots(rows)
      setTab('compose')
    }

    return {
      setForm: (patch: Partial<FormState>) => apply(prev => ({ ...clearError(prev, 'submit'), form: { ...prev.form, ...patch } })),
      setShots: (rows: ShotRow[]) => {
        setShots(rows)
        apply(prev => ({ ...clearError(prev, 'submit'), form: { ...prev.form, markdownTable: toMarkdown(rows) } }))
      },
      submit,
      cancel: (jobId: string) => {
        void run(async () => {
          try {
            const job = await cancelJob(jobId)
            apply(prev => setNotice(mergeJobs(prev, [job]), 'warn', '已发送取消：' + jobId))
          } catch (error) {
            apply(prev => setError(prev, 'submit', explainError(error, 'submit')))
          }
        })
      },
      rerunExact,
      loadSnapshot,
      replay: (jobId: string) => {
        void run(async () => {
          try {
            const accepted = await replayJob(jobId)
            apply(prev => setNotice(onProduceAccepted(prev, accepted), 'ok', '已一键重放：' + accepted.jobId))
          } catch (error) {
            apply(prev => setError(prev, 'submit', explainError(error, 'submit')))
          }
        })
      },
      saveConfig: (patch: Record<string, unknown>) => {
        void run(async () => {
          try {
            const result = await saveConfig(patch)
            const rejected = result.rejected.length === 0 ? '' : '；未接受：' + result.rejected.join('、')
            apply(prev => setNotice(clearError(prev, 'config'), 'ok', '已写入 ' + result.written.length + ' 项' + rejected))
            refresh()
          } catch (error) {
            apply(prev => setError(prev, 'config', explainError(error, 'config')))
          }
        })
      },
      probe: () => {
        void run(async () => {
          try {
            const result = await probeMagi2()
            apply(prev => setNotice(prev, result.state === 'ready' ? 'ok' : result.state === 'pending_quota' ? 'warn' : 'danger', result.hint))
            refresh()
          } catch (error) {
            apply(prev => setError(prev, 'config', explainError(error, 'config')))
          }
        })
      },
      refresh: () => refresh(),
      openLightbox: (media: MediaRef) => setLightbox(media),
    }
  }, [apply, refresh])

  // ── 渲染 ───────────────────────────────────────────────────────────────
  const props: PanelProps = { state, actions, shots, now, busy }
  const stale = isStale(state, now)

  const banner = stale
    ? h('div', { className: 'vf-alert vf-alert-warn', role: 'status' },
      h('div', { className: 'vf-row', style: { justifyContent: 'space-between' } },
        h('strong', null, '连接中断：数据已过期'),
        Btn({ label: '重试', onClick: () => refresh() })),
      h('div', { style: { fontSize: 11, marginTop: 3 } },
        state.conn.lastError !== undefined
          ? state.conn.lastError.hint
          : '状态快照超过 ' + Math.round((now - state.conn.fetchedAt) / 1000) + 's 未更新，提交已禁用。'))
    : null

  const notice = state.notice === undefined
    ? null
    : h('div', {
      className: 'vf-alert vf-alert-' + (state.notice.tone === 'ok' ? 'ok' : state.notice.tone === 'danger' ? 'danger' : state.notice.tone === 'warn' ? 'warn' : 'info'),
      role: 'status',
    },
    h('div', { className: 'vf-row', style: { justifyContent: 'space-between', gap: 8 } },
      h('span', null, state.notice.text),
      Btn({ label: '知道了', onClick: () => apply(clearNotice) })))

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'compose', label: '编排' },
    { id: 'jobs', label: state.jobs.length === 0 ? '作业' : '作业 · ' + state.jobs.length },
    { id: 'plans', label: 'Plan' },
    { id: 'settings', label: '设置' },
  ]

  return h('div', { className: 'vf-root' },
    h('div', { className: 'vf-head' },
      h('div', { className: 'vf-row', style: { gap: 8 } },
        h('span', { className: 'vf-title', style: { fontSize: 13.5, fontWeight: 650 } }, 'Video Forge'),
        state.form.mock ? Badge({ tone: 'warn', children: 'MOCK' }) : null,
        state.conn.status?.magi2.state === 'pending_quota' ? Badge({ tone: 'accent', children: 'MAGI-2 待配额' }) : null,
        busy ? Badge({ tone: 'plain', children: '处理中…' }) : null),
      h('div', { className: 'vf-row', style: { gap: 6 } },
        h('span', { className: 'vf-muted', style: { fontSize: 10.5 } },
          state.conn.fetchedAt === 0 ? '连接中…' : '更新于 ' + Math.max(0, Math.round((now - state.conn.fetchedAt) / 1000)) + 's 前'),
        Btn({ label: '刷新', onClick: () => refresh() }))),
    banner,
    notice,
    Tabs({ items: tabs, value: tab, onChange: (next: string) => setTab(next as TabId) }),
    h(TabPanel, { id: 'compose', active: tab === 'compose', children: ComposerPanel(props) }),
    h(TabPanel, { id: 'jobs', active: tab === 'jobs', children: JobsPanel(props) }),
    h(TabPanel, { id: 'plans', active: tab === 'plans', children: PlansPanel(props) }),
    h(TabPanel, { id: 'settings', active: tab === 'settings', children: SettingsPanel(props) }),
    lightbox === undefined ? null : Lightbox({ media: lightbox, onClose: () => setLightbox(undefined) }))
}

export function apply(ctx: any): void {
  ctx.effect(
    () => ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: '@dsh-external/dsh-video-forge',
      order: 36,
      label: () => 'Video Forge',
    }, VideoForgePanel)),
    'dsh-video-forge: workbench panel',
  )
}
