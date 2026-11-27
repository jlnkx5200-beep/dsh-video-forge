/**
 * 配置与密钥解析。
 *
 * 解析链（与本工作区既有 `seedream` 插件一致，但**各写各的文件**，互不覆盖）：
 *   plugin config → ~/.dsh/video-forge.json → 环境变量
 *
 * 任何 Key 都不许硬编码；`~/.dsh/video-forge.json` 归本插件所有，面板可写。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function userConfigPath(): string {
  return join(dshHome(), 'video-forge.json')
}

export interface ForgeUserConfig {
  arkApiKey?: string
  minimaxApiKey?: string
  /** MiniMax 有国际站 api.minimax.io 与国内站 api.minimaxi.com，Key 不通用，故可配。 */
  minimaxBaseUrl?: string
  comfyBaseUrl?: string
  /** Sand.ai 官方直连（MAGI-2）—— 只允许官方基址，不接任何第三方聚合网关。 */
  sandBaseUrl?: string
  sandApiKey?: string
  /** MAGI-2 默认时长（秒）：4–30 整数，官方原生支持 15–30s 连续分镜。 */
  defaultMagi2Duration?: number
  /** 供 ComfyUI 侧 Python 节点回调本插件用的令牌（可选）。 */
  bridgeToken?: string
}

export function readUserConfig(): ForgeUserConfig {
  try {
    const parsed = JSON.parse(readFileSync(userConfigPath(), 'utf8')) as Record<string, unknown>
    const out: ForgeUserConfig = {}
    for (const key of ['arkApiKey', 'minimaxApiKey', 'minimaxBaseUrl', 'comfyBaseUrl', 'sandBaseUrl', 'sandApiKey', 'bridgeToken'] as const) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim()
    }
    const duration = parsed['defaultMagi2Duration']
    if (typeof duration === 'number' && Number.isFinite(duration)) out.defaultMagi2Duration = clampMagi2Duration(duration)
    return out
  } catch {
    return {}
  }
}

export function writeUserConfig(patch: ForgeUserConfig): void {
  const current = readUserConfig()
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'string' && value.trim() === '') delete next[key]
    else if (typeof value === 'string') next[key] = value.trim()
    else if (typeof value === 'number' && Number.isFinite(value)) next[key] = value
  }
  mkdirSync(dshHome(), { recursive: true })
  writeFileSync(userConfigPath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
}

/**
 * 复用既有 `@dsh-external/dsh-seedream` 插件的用户配置（`~/.dsh/seedream.json`）。
 *
 * 为什么不复制一份：同一把 Ark Key 存两处，轮换时必忘改一处。这里只在自身链路
 * （插件 config → video-forge.json → 环境变量）全未命中时**只读**回退，绝不写。
 */
export function readLegacySeedreamKey(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome(), 'seedream.json'), 'utf8')) as Record<string, unknown>
    const value = parsed.apiKey
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

/** MAGI-2 时长夹紧：官方只接受 4–30 的整数秒。 */
export function clampMagi2Duration(value: number): number {
  if (!Number.isFinite(value)) return 8
  return Math.min(30, Math.max(4, Math.round(value)))
}

export type KeyKind = 'ark' | 'minimax' | 'sand' | 'bridge'
export type KeySource = 'plugin-config' | 'user-config' | 'env' | 'seedream-plugin' | 'none'

export interface ResolvedKey {
  key: string
  source: KeySource
}

export interface KeyChainInput {
  configKey?: string
  userKey?: string
  envName: string
}

/** 统一解析链：config → 用户配置 → 环境变量。返回 key 与来源，便于面板显示。 */
export function resolveKey(chain: KeyChainInput): ResolvedKey {
  if (typeof chain.configKey === 'string' && chain.configKey.trim() !== '') {
    return { key: chain.configKey.trim(), source: 'plugin-config' }
  }
  if (typeof chain.userKey === 'string' && chain.userKey.trim() !== '') {
    return { key: chain.userKey.trim(), source: 'user-config' }
  }
  const env = (process.env[chain.envName] ?? '').trim()
  if (env !== '') return { key: env, source: 'env' }
  return { key: '', source: 'none' }
}

/** Key 打码：只露前 3 后 4。 */
export function keyHint(key: string): string {
  if (key === '') return ''
  return key.length <= 8 ? '****' : key.slice(0, 3) + '…' + key.slice(-4)
}

export interface ForgePaths {
  home: string
  outDir: string
  cacheDir: string
  plansDir: string
  tmpDir: string
}

export function ensureDirs(base: string): ForgePaths {
  // 面板/工具/ComfyUI 产物都在同一个 base 下分目录，便于一键打包归档。
  const outDir = join(base, 'out')
  const cacheDir = join(base, 'cache')
  const plansDir = join(base, 'plans')
  const tmpDir = join(base, 'tmp')
  for (const dir of [base, outDir, cacheDir, plansDir, tmpDir]) mkdirSync(dir, { recursive: true })
  return { home: base, outDir, cacheDir, plansDir, tmpDir }
}

/** 文件存在且非空（用于判断某个产物是否还在）。 */
export function fileOk(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0
  } catch {
    return false
  }
}

/** Windows 上给 Python 子进程用的路径（F:\x → F:\x 原样即可，仅统一分隔符）。 */
export function toNativePath(path: string): string {
  return process.platform === 'win32' ? path.replace(/\//g, '\\') : path
}
