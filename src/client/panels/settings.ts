/**
 * 设置面板：Ark / MiniMax / Sand.ai 三把 Key 的录入（P1-7，只回显掩码）、
 * 全部配置项（P1-6）、MAGI-2 手动探针（默认不自动探测，避免将来误扣费）、后端健康与路径。
 */
import * as React from 'react'
import { h } from '../h.js'
import { Alert, Badge, Btn, Card, Field, TextInput, Kv } from '../components.js'
import type { Magi2KeyState } from '../api.js'
import type { PanelProps } from '../panel-types.js'

const STATE_LABEL: Record<Magi2KeyState, string> = {
  missing_key: '未配置 Key',
  invalid_key: 'Key 无效（401）',
  pending_quota: '已鉴权 · 配额不可用',
  // 免费 GET 200 只证明 Key 有效，不代表有余额：标签如实写「待生成确认」，不写「就绪/可生成」。
  ready: '鉴权通过 · 待生成确认',
  configured_unprobed: '已配置 · 未探测',
}

const STATE_TONE: Record<Magi2KeyState, 'ok' | 'warn' | 'danger' | 'plain'> = {
  missing_key: 'danger',
  invalid_key: 'danger',
  pending_quota: 'warn',
  ready: 'ok',
  configured_unprobed: 'plain',
}

interface Draft {
  arkApiKey: string
  minimaxApiKey: string
  sandApiKey: string
  arkBaseUrl: string
  minimaxBaseUrl: string
  sandBaseUrl: string
  comfyBaseUrl: string
  workflowDir: string
  dataDir: string
  ffmpegPath: string
  defaultSeedreamModel: string
  minimaxModel: string
  minimaxResolution: string
  defaultMagi2Duration: string
}

const EMPTY: Draft = {
  arkApiKey: '', minimaxApiKey: '', sandApiKey: '',
  arkBaseUrl: '', minimaxBaseUrl: '', sandBaseUrl: '',
  comfyBaseUrl: '', workflowDir: '', dataDir: '', ffmpegPath: '',
  defaultSeedreamModel: '', minimaxModel: '', minimaxResolution: '',
  defaultMagi2Duration: '',
}

export function SettingsPanel(props: PanelProps): React.ReactElement {
  const { state, actions } = props
  const status = state.conn.status
  const [draft, setDraft] = React.useState<Draft>(EMPTY)
  const [reveal, setReveal] = React.useState(false)

  const set = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch })
  const save = (): void => {
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(draft)) {
      if (value.trim() === '') continue
      if (key === 'defaultMagi2Duration') patch[key] = Number(value)
      else patch[key] = value.trim()
    }
    actions.saveConfig(patch)
    // Key 类字段落盘后就从内存里清掉，避免明文长期驻留在组件状态里
    setDraft({ ...EMPTY, ...Object.fromEntries(Object.entries(draft).filter(([key]) => !key.endsWith('ApiKey'))) })
  }

  const keyRow = (label: string, present: boolean, hint: string, source: string, field: keyof Draft): React.ReactElement =>
    h('div', { className: 'vf-col', style: { gap: 3 } },
      h('div', { className: 'vf-row', style: { justifyContent: 'space-between' } },
        h('span', { style: { fontSize: 11.5 } }, label),
        h('div', { className: 'vf-row', style: { gap: 4 } },
          Badge({ tone: present ? 'ok' : 'plain', children: present ? '已配置' : '未配置' }),
          h('span', { className: 'vf-muted vf-mono', style: { fontSize: 9.5 } }, hint + ' · ' + source))),
      h('div', { className: 'vf-row', style: { gap: 4 } },
        h('div', { style: { flex: 1 } }, TextInput({
          value: draft[field],
          onChange: value => set({ [field]: value } as Partial<Draft>),
          placeholder: '粘贴新 Key（只写入 ~/.dsh/video-forge.json，永不回显明文）',
          ariaLabel: label,
          mono: true,
        })),
        Btn({ label: '清空', onClick: () => set({ [field]: '' } as Partial<Draft>) })))

  const health = status === undefined
    ? h('div', { className: 'vf-muted', style: { fontSize: 11 } }, '尚未拿到后端状态')
    : h('div', { className: 'vf-col', style: { gap: 3 } }, status.providers.map(provider => h('div', { key: provider.provider, className: 'vf-row', style: { justifyContent: 'space-between', fontSize: 11.5 } },
      h('div', { className: 'vf-row', style: { gap: 6 } },
        Badge({ tone: provider.status === 'ok' ? 'ok' : provider.status === 'offline' ? 'danger' : 'warn', children: provider.provider }),
        h('span', { className: 'vf-muted' }, provider.detail)),
      h('span', { className: 'vf-mono vf-muted', style: { fontSize: 10 } }, provider.latencyMs === undefined ? '' : provider.latencyMs + 'ms'))))

  const magi2 = status?.magi2

  return h('div', { className: 'vf-grid' },
    Card({
      title: 'Key（只回显掩码）',
      actions: Btn({ label: reveal ? '隐藏说明' : '怎么填', onClick: () => setReveal(!reveal) }),
      children: h('div', { className: 'vf-col', style: { gap: 10 } },
        keyRow('Ark / Seedream', status?.keys.ark.present ?? false, status?.keys.ark.hint ?? '—', status?.keys.ark.source ?? 'none', 'arkApiKey'),
        keyRow('MiniMax H3', status?.keys.minimax.present ?? false, status?.keys.minimax.hint ?? '—', status?.keys.minimax.source ?? 'none', 'minimaxApiKey'),
        keyRow('Sand.ai（MAGI-2）', status?.keys.sand.present ?? false, status?.keys.sand.hint ?? '—', status?.keys.sand.source ?? 'none', 'sandApiKey'),
        reveal
          ? h('div', { className: 'vf-muted', style: { fontSize: 10.5, lineHeight: 1.7 } },
            '优先级：插件 config → ~/.dsh/video-forge.json → 环境变量（ARK_API_KEY / MINIMAX_API_KEY / SAND_API_KEY）。' +
            ' 也可以跑 node scripts/set-keys.mjs 在终端里掩码录入。这里保存只会写 user config，不会进仓库、不会回显明文。' +
            (status === undefined ? '' : ' 当前写入目标：' + status.userConfigPath))
          : null,
        h('div', { className: 'vf-row', style: { gap: 6 } },
          Btn({ label: '保存', variant: 'primary', onClick: save }),
          Btn({ label: '刷新状态', onClick: actions.refresh })))
    }),

    Card({
      title: 'MAGI-2 官方状态',
      actions: h('div', { className: 'vf-row', style: { gap: 4 } },
        Badge({ tone: magi2 === undefined ? 'plain' : STATE_TONE[magi2.state], children: magi2 === undefined ? '未知' : STATE_LABEL[magi2.state] }),
        Btn({ label: '探针检测', disabled: magi2 === undefined || !(status?.keys.sand.present ?? false), onClick: actions.probe })),
      children: h('div', { className: 'vf-col', style: { gap: 6 } },
        h('div', { className: 'vf-muted', style: { fontSize: 11 } }, magi2?.detail ?? '尚无探针结果'),
        magi2?.state === 'pending_quota'
          ? Alert({ tone: 'warn', title: '鉴权通过、配额不可用（400 insufficient_credits）', hint: '此状态不扣费；配额下发后无需改代码，直接生成或点作业里的「一键重放」。' })
          : null,
        magi2?.state === 'ready'
          ? Alert({ tone: 'info', title: '鉴权通过（待首次生成确认配额）', hint: '探针只打免计费的 GET：它证明 Key 有效，但不查余额。首次生成若返回 400 insufficient_credits，作业会自动转为 pending_quota 并保留参数等你重放。' })
          : null,
        magi2?.state === 'missing_key'
          ? Alert({ tone: 'info', title: '还没有配置 SAND_API_KEY', hint: '在上面的 Sand.ai 一行粘贴后保存，再点探针检测。' })
          : null,
        h('div', { className: 'vf-muted', style: { fontSize: 10.5 } },
          '探针只发免计费的 GET（/v1/assets、/v1/account、/v1/models），且**默认不会自动探测**——避免将来有配额时误扣费。结果缓存在 Host 内存里。'),
        h('div', { className: 'vf-row', style: { gap: 8, fontSize: 10.5 } },
          h('span', { className: 'vf-muted' }, 'baseUrl'),
          h('span', { className: 'vf-mono' }, magi2?.baseUrl ?? '—'),
          h('span', { className: 'vf-muted' }, '默认时长'),
          h('span', { className: 'vf-mono' }, String(magi2?.defaultDuration ?? 8) + 's')))
    }),

    Card({
      title: '端点与模型',
      children: h('div', { className: 'vf-grid' },
        Field({ label: 'Ark baseUrl', children: TextInput({ value: draft.arkBaseUrl, onChange: value => set({ arkBaseUrl: value }), placeholder: '留空=保持现值', mono: true, ariaLabel: 'Ark baseUrl' }) }),
        Field({ label: 'MiniMax baseUrl', children: TextInput({ value: draft.minimaxBaseUrl, onChange: value => set({ minimaxBaseUrl: value }), placeholder: '留空=保持现值', mono: true, ariaLabel: 'MiniMax baseUrl' }) }),
        Field({ label: 'Sand.ai baseUrl', children: TextInput({ value: draft.sandBaseUrl, onChange: value => set({ sandBaseUrl: value }), placeholder: 'https://api.sand.ai', mono: true, ariaLabel: 'Sand baseUrl' }) }),
        Field({ label: 'ComfyUI baseUrl', children: TextInput({ value: draft.comfyBaseUrl, onChange: value => set({ comfyBaseUrl: value }), placeholder: 'http://127.0.0.1:8188', mono: true, ariaLabel: 'ComfyUI baseUrl' }) }),
        Field({ label: '默认 Seedream 模型', children: TextInput({ value: draft.defaultSeedreamModel, onChange: value => set({ defaultSeedreamModel: value }), placeholder: '5.0-flash', ariaLabel: '默认 Seedream 模型' }) }),
        Field({ label: '默认 H3 模型', children: TextInput({ value: draft.minimaxModel, onChange: value => set({ minimaxModel: value }), placeholder: 'MiniMax-H3', ariaLabel: '默认 H3 模型' }) }),
        Field({ label: '默认 H3 分辨率', children: TextInput({ value: draft.minimaxResolution, onChange: value => set({ minimaxResolution: value }), placeholder: '768P', ariaLabel: '默认 H3 分辨率' }) }),
        Field({ label: 'MAGI-2 默认时长', children: TextInput({ value: draft.defaultMagi2Duration, onChange: value => set({ defaultMagi2Duration: value }), placeholder: '8', ariaLabel: 'MAGI-2 默认时长' }) }),
        Field({ label: 'workflowDir', children: TextInput({ value: draft.workflowDir, onChange: value => set({ workflowDir: value }), placeholder: '留空=插件内 workflows', mono: true, ariaLabel: 'workflowDir' }) }),
        Field({ label: 'dataDir', children: TextInput({ value: draft.dataDir, onChange: value => set({ dataDir: value }), placeholder: '留空=~/.dsh/video-forge', mono: true, ariaLabel: 'dataDir' }) }),
        Field({ label: 'ffmpegPath', children: TextInput({ value: draft.ffmpegPath, onChange: value => set({ ffmpegPath: value }), placeholder: '留空=自动探测', mono: true, ariaLabel: 'ffmpegPath' }) }),
        h('div', { className: 'vf-col', style: { gap: 4, justifyContent: 'flex-end' } },
          Btn({ label: '保存配置', variant: 'primary', onClick: save }),
          h('span', { className: 'vf-muted', style: { fontSize: 10 } }, 'maxConcurrent 属于插件 config（需重启生效），不接受热写。')))
    }),

    Card({
      title: '后端健康与路径',
      actions: Btn({ label: '刷新', onClick: actions.refresh }),
      children: h('div', { className: 'vf-col', style: { gap: 8 } },
        health,
        status === undefined
          ? null
          : h(Kv, {
            rows: [
              ['clientId', status.clientId],
              ['out', status.paths.out],
              ['cache', status.paths.cache + '（' + status.cache.entries + ' 条）'],
              ['plans', status.paths.plans],
              ['workflows', status.comfyWorkflowDir],
              ['ffmpeg', typeof status.ffmpeg === 'string' ? status.ffmpeg : (status.ffmpeg.path ?? '—')],
            ],
          }),
        h('div', { className: 'vf-muted', style: { fontSize: 10.5 } },
          '安全提示：桥接端点默认只接受回环地址；跨进程调用请配置 bridgeToken。Key 只落在 ~/.dsh/video-forge.json 与 ~/.dsh/seedream.json，不进仓库。'))
    }))
}
