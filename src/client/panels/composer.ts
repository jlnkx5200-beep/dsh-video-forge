/**
 * 编排面板：结构化分镜编辑 + Markdown 同步（P1-3）、完整生成参数（P1-6）、
 * MAGI-2 参数与"实际会发什么"预览（契约可视化）、成本估算、Mock 斜纹警示（P0-4）。
 * stale（P0-2）时提交按钮直接禁用，并给出为什么。
 */
import * as React from 'react'
import { h } from '../h.js'
import { Badge, Btn, Card, Check, Field, Select, StripeWarning, TextArea, TextInput, Alert } from '../components.js'
import { canSubmit, isStale } from '../state.js'
import { MOVES, STRATEGIES, STRATEGIES as STRATEGY_LIST, TRANSITIONS, blankShot, parseMarkdownShots, toMarkdown, toShotPayload, validateShots } from '../shots.js'
import { compareEngines, estimate } from '../cost-estimator.js'
import { sanitizeMagi2Payload } from '../magi2-payload-sanitizer.js'
import { listStylePrompts } from '../../bridge/style-prompts.js'
import type { PanelProps } from '../panel-types.js'

// 风格 id 只允许出现在 src/bridge/style-prompts.ts（docs/visual-quality-standard.md 纪律）：这里从映射表取，
// 面板里不再留一份手抄的预设名，新增/改名预设只改一处。
const PRESET_OPTIONS = listStylePrompts().map(item => item.id)
const PRESET_LABELS: Record<string, string> = Object.fromEntries(listStylePrompts().map(item => [item.id, item.label]))
const QUALITY = ['production', 'draft'] as const
const RESOLUTIONS = ['480P', '768P', '2K'] as const

export function ComposerPanel(props: PanelProps): React.ReactElement {
  const { state, actions, shots, now, busy } = props
  const form = state.form
  const [editorMode, setEditorMode] = React.useState<'table' | 'markdown'>('table')
  const [showPayload, setShowPayload] = React.useState(false)

  const issues = validateShots(shots)
  const errors = issues.filter(issue => issue.level === 'error')
  const stale = isStale(state, now)
  const submitDisabled = busy || stale || errors.length > 0

  const totalSeconds = shots.reduce((sum, shot) => sum + shot.durationSec, 0)
  const totalShots = shots.length
  const strategy = form.strategy
  const usesMagi2 = strategy.startsWith('magi2')
  const cost = estimate({
    shots: totalShots,
    secondsPerShot: totalShots === 0 ? 0 : totalSeconds / totalShots,
    strategy,
    minimaxResolution: form.minimaxResolution,
    imagesPerShot: strategy === 'magi2-direct' ? 0 : 1,
    comfyCallsPerShot: strategy === 'comfy-pipeline' ? 3 : strategy === 'seedream-static' || strategy === 'still-3d' ? 1 : 0,
    mock: form.mock,
    useCache: form.useCache,
    magi2Duration: form.magi2Duration,
  })
  const versus = compareEngines({
    shots: Math.max(1, totalShots),
    secondsPerShot: totalShots === 0 ? 8 : totalSeconds / totalShots,
    strategy,
    minimaxResolution: form.minimaxResolution,
  })

  const payloadPreview = sanitizeMagi2Payload({
    prompt: shots[0]?.prompt,
    duration: form.magi2Duration,
    resolution: '1080p',
    aspectRatio: '16:9',
    generateAudio: form.generateAudio,
    model: form.magi2Model,
    firstFrame: shots[0]?.firstFrame,
    lastFrame: shots[0]?.lastFrame,
    referenceImages: shots[0]?.referenceImages,
  })

  const updateShot = (index: number, patch: Partial<(typeof shots)[number]>): void => {
    const next = shots.map((shot, i) => (i === index ? { ...shot, ...patch } : shot))
    actions.setShots(next)
  }

  const removeShot = (index: number): void => {
    actions.setShots(shots.filter((_, i) => i !== index))
  }

  const tableRows = shots.map((shot, index) => h('div', { key: shot.id + index, className: 'vf-card', style: { padding: 8 } },
    h('div', { className: 'vf-row', style: { justifyContent: 'space-between' } },
      h('span', { className: 'vf-badge vf-badge-accent' }, '#' + (index + 1)),
      h('div', { className: 'vf-row', style: { gap: 4 } },
        h('input', {
          className: 'vf-input',
          style: { width: 74 },
          value: shot.time,
          'aria-label': '第 ' + (index + 1) + ' 镜时间',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
            const text = event.target.value
            updateShot(index, { time: text, durationSec: parseDurationSafe(text) })
          },
        }),
        Btn({ label: '删除', variant: 'danger', ariaLabel: '删除第 ' + (index + 1) + ' 镜', onClick: () => removeShot(index) }))),
    h('div', { className: 'vf-shot-row' },
      h('div', { className: 'vf-col', style: { gap: 4 } },
        Select({ value: shot.shot, options: ['wide', 'medium', 'close', 'macro'], onChange: value => updateShot(index, { shot: value }), ariaLabel: '景别' }),
        Select({ value: shot.move, options: MOVES, onChange: value => updateShot(index, { move: value }), ariaLabel: '运镜' })),
      h('div', { className: 'vf-col', style: { gap: 4 } },
        TextArea({
          value: shot.prompt,
          rows: 2,
          ariaLabel: '第 ' + (index + 1) + ' 镜提示词',
          placeholder: '这个镜头拍什么（英文更稳）',
          onChange: value => updateShot(index, { prompt: value }),
        }),
        h('div', { className: 'vf-row', style: { gap: 4 } },
          Select({ value: shot.strategy, options: STRATEGY_LIST, onChange: value => updateShot(index, { strategy: value }), ariaLabel: '产线策略' }),
          Select({ value: shot.transition, options: TRANSITIONS, onChange: value => updateShot(index, { transition: value }), ariaLabel: '转场' })))),
    shot.strategy.startsWith('magi2')
      ? h('div', { className: 'vf-row', style: { gap: 6 } },
        h('div', { style: { flex: '1 1 140px' } }, TextInput({ value: shot.firstFrame ?? '', onChange: value => updateShot(index, { firstFrame: value }), placeholder: '首帧 assetId / 本地路径（可选）', ariaLabel: '首帧', mono: true })),
        h('div', { style: { flex: '1 1 140px' } }, TextInput({ value: shot.lastFrame ?? '', onChange: value => updateShot(index, { lastFrame: value }), placeholder: '尾帧 assetId / 本地路径（可选）', ariaLabel: '尾帧', mono: true })),
        Check({
          label: '生成音轨',
          checked: shot.generateAudio ?? true,
          onChange: value => updateShot(index, { generateAudio: value }),
        }))
      : null))

  return h('div', { className: 'vf-col', style: { gap: 10 } },
    // ── 分镜 ───────────────────────────────────────────────────────────
    Card({
      title: '分镜 · ' + totalShots + ' 镜 / ' + totalSeconds + 's',
      actions: h('div', { className: 'vf-row', style: { gap: 4 } },
        Btn({ label: editorMode === 'table' ? 'Markdown' : '结构化', onClick: () => setEditorMode(editorMode === 'table' ? 'markdown' : 'table') }),
        Btn({
          label: '+ 加一镜',
          onClick: () => {
            const next = [...shots, blankShot(shots.length)]
            actions.setShots(next)
          },
        })),
      children: [
        editorMode === 'table'
          ? h('div', { className: 'vf-col', style: { gap: 8 } }, tableRows)
          : h('div', { className: 'vf-col', style: { gap: 6 } },
            TextArea({
              value: form.markdownTable,
              rows: 12,
              ariaLabel: 'Markdown 分镜表',
              onChange: (text) => {
                const parsed = parseMarkdownShots(text)
                actions.setForm({ markdownTable: text })
                if (parsed.length > 0) actions.setShots(parsed)
              },
            }),
            h('div', { className: 'vf-muted', style: { fontSize: 10.5 } }, '支持 video-shotcraft 的 6 列表头；改完自动同步到结构化编辑。')),
        errors.length > 0
          ? h('div', { className: 'vf-col', style: { gap: 4 } }, errors.slice(0, 4).map((issue, index) => h('div', { key: index, className: 'vf-muted', style: { fontSize: 11, color: 'var(--vf-danger)' } }, '· ' + issue.message)))
          : null,
        h('div', { className: 'vf-row', style: { gap: 6 } },
          h('span', { className: 'vf-muted', style: { fontSize: 10.5 } }, '标题'),
          h('div', { style: { flex: '1 1 200px' } }, TextInput({ value: form.title, onChange: value => actions.setForm({ title: value }), ariaLabel: '片子标题' }))),
        h('details', { className: 'vf-details' },
          h('summary', null, '导出为 Markdown'),
          h('div', { className: 'vf-code' }, toMarkdown(shots))),
      ],
    }),

    // ── 生成参数 ────────────────────────────────────────────────────────
    Card({
      title: '生成参数',
      children: h('div', { className: 'vf-grid' },
        Field({ label: '风格预设', children: Select({ value: form.preset, options: PRESET_OPTIONS, labels: PRESET_LABELS, onChange: value => actions.setForm({ preset: value }), ariaLabel: '风格预设' }) }),
        Field({ label: '产线策略', hint: 'magi2-* 需要 Sand.ai 官方配额', children: Select({ value: form.strategy, options: STRATEGIES, onChange: value => actions.setForm({ strategy: value }), ariaLabel: '产线策略' }) }),
        Field({ label: '质量模式', hint: 'draft 允许伪算法与 480P', children: Select({ value: form.qualityMode, options: QUALITY, onChange: value => actions.setForm({ qualityMode: value === 'draft' ? 'draft' : 'production' }), ariaLabel: '质量模式' }) }),
        Field({ label: 'H3 分辨率', children: Select({ value: form.minimaxResolution, options: RESOLUTIONS, onChange: value => actions.setForm({ minimaxResolution: value }), ariaLabel: 'H3 分辨率' }) }),
        Field({ label: '帧率', children: TextInput({ value: String(form.fps), onChange: value => actions.setForm({ fps: clampInt(value, 12, 60, 30) }), ariaLabel: '帧率' }) }),
        Field({ label: '画幅', children: h('div', { className: 'vf-row', style: { gap: 4 } },
          h('div', { style: { flex: 1 } }, TextInput({ value: String(form.width), onChange: value => actions.setForm({ width: clampInt(value, 480, 4096, 1920) }), ariaLabel: '宽' })),
          h('div', { style: { flex: 1 } }, TextInput({ value: String(form.height), onChange: value => actions.setForm({ height: clampInt(value, 480, 4096, 1080) }), ariaLabel: '高' }))) }),
        h('div', { className: 'vf-col', style: { gap: 6, gridColumn: '1 / -1' } },
          Check({ label: '使用内容缓存（useCache）', checked: form.useCache, hint: '同参数重复生成不重复计费；关掉就会重新调用 Provider', onChange: value => actions.setForm({ useCache: value }) }),
          Check({ label: 'Mock 模式（零成本占位）', checked: form.mock, hint: '产物是本地合成的占位资产', onChange: value => actions.setForm({ mock: value }) }),
          Check({ label: 'Dry run（只算不发）', checked: form.dryRun, onChange: value => actions.setForm({ dryRun: value }) }),
          Check({ label: '背景板剥离（plate）', checked: form.enablePlate, hint: '只在主体清晰的产品/人物镜头开', onChange: value => actions.setForm({ enablePlate: value }) }))),
    }),

    // ── MAGI-2 ─────────────────────────────────────────────────────────
    Card({
      title: 'MAGI-2（Sand.ai 官方直连）',
      actions: Badge({ tone: usesMagi2 ? 'accent' : 'plain', children: usesMagi2 ? '当前策略使用' : '备用引擎' }),
      children: h('div', { className: 'vf-col', style: { gap: 8 } },
        h('div', { className: 'vf-grid' },
          Field({ label: '模型', children: TextInput({ value: form.magi2Model, onChange: value => actions.setForm({ magi2Model: value }), ariaLabel: 'MAGI-2 模型', mono: true }) }),
          Field({ label: '时长（4–30 整数秒）', children: TextInput({ value: String(form.magi2Duration), onChange: value => actions.setForm({ magi2Duration: clampInt(value, 4, 30, 8) }), ariaLabel: 'MAGI-2 时长' }) }),
          h('div', { className: 'vf-col', style: { gap: 4 } },
            Check({ label: '生成音轨（generateAudio）', checked: form.generateAudio, hint: '关掉后产物是无音轨 MP4，元信息标记 hasAudio=false', onChange: value => actions.setForm({ generateAudio: value }) }))),
        h('div', { className: 'vf-row', style: { gap: 6 } },
          Badge({ tone: payloadPreview.mode === 'ark' ? 'warn' : 'ok', children: payloadPreview.mode === 'ark' ? 'Ark 兼容端点（首尾帧）' : 'Native 端点（多参考/T2V）' }),
          payloadPreview.stripped.length > 0 ? Badge({ tone: 'danger', children: '剥离字段：' + payloadPreview.stripped.join(', ') }) : null,
          Btn({ label: showPayload ? '收起请求体' : '看实际请求体', onClick: () => setShowPayload(!showPayload) })),
        showPayload
          ? h('div', { className: 'vf-code', style: { background: 'var(--vf-bg-elev)', border: '1px solid var(--vf-border)', borderRadius: 8, padding: 8 } }, JSON.stringify(payloadPreview.payload, null, 2))
          : null,
        payloadPreview.issues.length > 0
          ? h('div', { className: 'vf-col', style: { gap: 3 } }, payloadPreview.issues.map((issue, index) => h('div', {
            key: index,
            style: { fontSize: 11, color: issue.level === 'error' ? 'var(--vf-danger)' : 'var(--vf-warn)' },
          }, (issue.level === 'error' ? '✕ ' : '! ') + issue.message)))
          : null,
        h('div', { className: 'vf-muted', style: { fontSize: 10.5 } },
          '官方序列化红线：绝不传 watermark（连 false 都不传）、绝不传 role；未使用的可选字段 omit 不传 null；resolution 只接受 "1080p"；aspectRatio 只接受 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16。')),
    }),

    // ── 成本 ────────────────────────────────────────────────────────────
    Card({
      title: '成本估算（相对指数）',
      children: h('div', { className: 'vf-col', style: { gap: 6 } },
        h('div', { className: 'vf-row', style: { gap: 8 } },
          h('span', { style: { fontSize: 18, fontWeight: 700 } }, cost.total.toFixed(2)),
          h('span', { className: 'vf-muted', style: { fontSize: 11 } }, '基准 1.0 = 一张 Seedream 5.0-flash 静帧')),
        h('div', { className: 'vf-col', style: { gap: 2 } }, cost.lines.map((line, index) => h('div', { key: index, className: 'vf-row', style: { justifyContent: 'space-between', fontSize: 11.5 } },
          h('span', null, line.label),
          h('span', { className: 'vf-mono' }, line.units.toFixed(2) + ' · ' + line.detail)))),
        h('div', { className: 'vf-row', style: { gap: 6, marginTop: 4 } },
          Badge({ tone: 'plain', children: 'H3 ' + versus.minimax.total.toFixed(2) }),
          Badge({ tone: 'plain', children: 'MAGI-2 ' + versus.magi2.total.toFixed(2) }),
          Badge({ tone: 'accent', children: (versus.cheaper === 'magi2' ? 'MAGI-2' : 'H3') + ' 更省（差 ' + Math.abs(versus.delta).toFixed(2) + '）' })),
        cost.notes.length > 0 ? h('div', { className: 'vf-muted', style: { fontSize: 10.5, lineHeight: 1.6 } }, cost.notes.join(' ')) : null),
    }),

    // ── 提交 ────────────────────────────────────────────────────────────
    h('div', { className: 'vf-col', style: { gap: 6 } },
      stale
        ? Alert({
          tone: 'warn',
          title: '后端状态已断开，提交已禁用',
          hint: '连续 ' + state.conn.failures + ' 次刷新失败或状态超过 15s 未更新。表格与参数可以先编辑，恢复后即可提交。',
          actions: Btn({ label: '立即重试', onClick: actions.refresh }),
        })
        : null,
      h('div', { className: 'vf-row', style: { gap: 8 } },
        Btn({
          label: busy ? '提交中…' : '生成',
          variant: 'primary',
          disabled: submitDisabled,
          title: stale ? '后端断开时不允许提交' : errors.length > 0 ? errors[0]?.message : undefined,
          onClick: () => {
            const payloadShots = toShotPayload(shots)
            actions.setShots(shots)
            void payloadShots
            actions.submit()
          },
        }),
        Btn({ label: '刷新状态', onClick: actions.refresh }),
        h('span', { className: 'vf-muted', style: { fontSize: 10.5 } },
          form.mock ? '当前为 Mock 模式：零成本、占位产物' : form.dryRun ? 'Dry run：只计算不调用' : '真实调用会产生费用')),
      form.mock ? StripeWarning({ text: 'Mock 模式 · 占位资产，不可作为正式成片' }) : null),
  )
}

function clampInt(text: string, min: number, max: number, fallback: number): number {
  const value = Number(text)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function parseDurationSafe(text: string): number {
  const matches = text.match(/\d+(?:\.\d+)?/g)
  if (matches === null) return 4
  const value = Number(matches[matches.length - 1])
  return Number.isFinite(value) && value > 0 ? Math.min(30, Math.max(1, value)) : 4
}

export { canSubmit }
