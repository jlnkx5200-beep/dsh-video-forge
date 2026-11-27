import type { FormState, PanelState } from './state.js'
import type { ShotRow } from './shots.js'
import type { MediaRef } from './components.js'

/** 面板 → 状态层的动作集合（由 index.ts 统一实现，子面板只消费）。 */
export interface Actions {
  setForm: (patch: Partial<FormState>) => void
  setShots: (rows: ShotRow[]) => void
  submit: () => void
  cancel: (jobId: string) => void
  rerunExact: (jobId: string) => void
  loadSnapshot: (jobId: string) => void
  replay: (jobId: string) => void
  saveConfig: (patch: Record<string, unknown>) => void
  probe: () => void
  refresh: () => void
  openLightbox: (media: MediaRef) => void
}

export interface PanelProps {
  state: PanelState
  actions: Actions
  shots: ShotRow[]
  now: number
  busy: boolean
}
