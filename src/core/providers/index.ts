/**
 * Provider 注册表 —— 唯一允许"认识所有 Provider"的地方。
 *
 * 新增后端 = 实现 MediaProvider + 在这里注册 + 面板里加一行能力描述。
 * 调度层只按 id 取 provider，不认识任何一家 API 的细节。
 */
import type { MediaProvider, ProviderConfig, ProviderHealth, ProviderId } from './types.js'
import { SeedreamProvider } from './seedream.js'
import { MinimaxProvider } from './minimax.js'
import { ComfyuiProvider } from './comfyui.js'
import { MockProvider } from './mock.js'
import { Magi2Provider } from './magi2.js'

export * from './types.js'
export { SeedreamProvider, SEEDREAM_MODELS, SEEDREAM_SIZES, resolveSeedreamModel } from './seedream.js'
export { MinimaxProvider, MINIMAX_MODELS, MINIMAX_RESOLUTIONS, MINIMAX_RATIOS } from './minimax.js'
export { ComfyuiProvider } from './comfyui.js'
export { MockProvider } from './mock.js'
export {
  Magi2Provider, type Magi2KeyState, type Magi2ProbeResult, type Magi2ProviderOptions,
} from './magi2.js'
export {
  MAGI2_ASPECT_RATIOS, MAGI2_DEFAULT_DURATION, MAGI2_DEFAULT_MODEL, MAGI2_FORBIDDEN_FIELDS,
  MAGI2_LIMITS, MAGI2_RESOLUTIONS, assertNoForbiddenFields, buildArkBody, buildNativeBody,
  classifySandFailure, compact, normalizeAssetId, parseJsonBigIntSafe, pickMagi2Mode,
  validateMagi2Spec, type Magi2Mode, type Magi2Spec,
} from './magi2-payload.js'

export interface ProviderRegistryOptions {
  config: () => ProviderConfig
  clientId: () => string
  /** MAGI-2 资产上传索引（内容寻址）；缺省落在系统临时目录，便于脱离 runtime 单测。 */
  assetCacheFile?: () => string
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, MediaProvider>()

  constructor(private readonly opts: ProviderRegistryOptions) {
    const cfg = (): ProviderConfig => this.opts.config()
    this.register(new SeedreamProvider({
      baseUrl: () => cfg().arkBaseUrl,
      apiKey: () => cfg().arkApiKey,
      defaultModel: () => cfg().defaultSeedreamModel,
      maxImagesPerCall: () => 10,
    }))
    this.register(new MinimaxProvider({
      baseUrl: () => cfg().minimaxBaseUrl,
      apiKey: () => cfg().minimaxApiKey,
      defaultModel: () => cfg().defaultMinimaxModel,
      defaultResolution: () => cfg().minimaxResolution,
    }))
    this.register(new Magi2Provider({
      baseUrl: () => cfg().sandBaseUrl,
      apiKey: () => cfg().sandApiKey,
      defaultDuration: () => cfg().defaultMagi2Duration,
      assetCacheFile: () => this.opts.assetCacheFile?.() ?? '',
    }))
    this.register(new ComfyuiProvider({
      baseUrl: () => cfg().comfyBaseUrl,
      workflowDir: () => cfg().workflowDir,
      clientId: () => this.opts.clientId(),
    }))
    this.register(new MockProvider({ ffmpegPath: () => cfg().ffmpegPath }))
  }

  register(provider: MediaProvider): void {
    this.providers.set(provider.id, provider)
  }

  get(id: string): MediaProvider | undefined {
    return this.providers.get(id as ProviderId)
  }

  /** 取不到就抛 —— 静默回退到别的 Provider 会让人以为在花钱出图，实际是占位图。 */
  require(id: string): MediaProvider {
    const provider = this.get(id)
    if (provider === undefined) {
      throw new Error('未知 Provider：' + id + '（可用：' + this.ids().join(' / ') + '）')
    }
    return provider
  }

  has(id: string): boolean {
    return this.providers.has(id as ProviderId)
  }

  ids(): ProviderId[] {
    return [...this.providers.keys()]
  }

  all(): MediaProvider[] {
    return [...this.providers.values()]
  }

  capabilities(): Array<{ id: ProviderId; label: string; capabilities: ReturnType<MediaProvider['capabilities']> }> {
    return this.all().map(p => ({ id: p.id, label: p.label, capabilities: p.capabilities() }))
  }

  /** 并行探活；任一 Provider 抛错只影响它自己那一行。 */
  async healthAll(): Promise<ProviderHealth[]> {
    return Promise.all(this.all().map(async provider => {
      try {
        return await provider.health()
      } catch (error) {
        return {
          provider: provider.id,
          status: 'offline' as const,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: Date.now(),
        }
      }
    }))
  }
}
