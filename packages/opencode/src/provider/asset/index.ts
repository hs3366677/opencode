import { Log } from "../../util/log"
import { Config } from "../../config/config"
import { Auth } from "../../auth"
import { AssetProvider } from "./asset-provider"
import { MeshyProvider } from "./meshy"
import { DoubaoProvider } from "./doubao"
import { SunoProvider } from "./suno"
import { ReplicateProvider } from "./replicate"

/**
 * Central registry for asset generation providers.
 *
 * Handles provider lifecycle, model discovery, and 3-tier model resolution:
 *   1. Per-request model override
 *   2. Type-specific default (from config)
 *   3. Provider's default model
 */
export namespace AssetProviderRegistry {
  const log = Log.create({ service: "asset.registry" })

  const providers = new Map<string, AssetProvider.Provider>()
  const modelCache = new Map<string, AssetProvider.ModelInfo[]>()

  /** Built-in provider factories keyed by provider ID */
  const BUILTIN_FACTORIES: Record<
    string,
    (config: { apiKey: string; apiUrl?: string }) => AssetProvider.Provider
  > = {
    replicate: (config) => new ReplicateProvider(config),
    meshy: (config) => new MeshyProvider(config),
    doubao: (config) => new DoubaoProvider(config),
    suno: (config) => new SunoProvider(config),
  }

  /** Default provider for each asset type (when no config override) */
  const TYPE_PROVIDER_DEFAULTS: Partial<Record<AssetProvider.AssetType, string>> = {
    model: "meshy",
    mesh: "meshy",
    scene: "meshy",
    texture: "replicate",
    sprite: "replicate",
    cubemap: "replicate",
    material: "replicate",
    audio_sfx: "suno",
    audio_music: "suno",
  }

  // ── Registration ─────────────────────────────────────────────────────

  export function register(provider: AssetProvider.Provider): void {
    log.info("registering asset provider", { id: provider.id, name: provider.name })
    providers.set(provider.id, provider)
    modelCache.delete(provider.id)
  }

  export function unregister(providerId: string): void {
    providers.delete(providerId)
    modelCache.delete(providerId)
  }

  export function get(providerId: string): AssetProvider.Provider | undefined {
    return providers.get(providerId)
  }

  export function list(): AssetProvider.Provider[] {
    return Array.from(providers.values())
  }

  // ── Initialization from config ───────────────────────────────────────

  export async function initFromConfig(): Promise<void> {
    const config = await Config.get()
    const assetConfig = (config as any).asset_provider as
      | Record<string, AssetProvider.ProviderConfig>
      | undefined

    if (assetConfig) {
      for (const [providerId, providerConfig] of Object.entries(assetConfig)) {
        if (providerConfig.enabled === false) {
          log.info("asset provider disabled", { id: providerId })
          continue
        }

        const factory = BUILTIN_FACTORIES[providerId]
        if (!factory) {
          log.warn("unknown asset provider", { id: providerId })
          continue
        }

        // Resolve API key: config > env var > auth.json
        let apiKey = providerConfig.api_key
          ?? (providerConfig.api_key_env ? process.env[providerConfig.api_key_env] : undefined)
        if (!apiKey) {
          const authInfo = await Auth.get(providerId)
          if (authInfo?.type === "api") {
            apiKey = authInfo.key
          }
        }
        if (!apiKey) {
          log.warn("asset provider missing API key", {
            id: providerId,
            env: providerConfig.api_key_env ?? "(not configured)",
          })
          continue
        }

        const provider = factory({
          apiKey,
          apiUrl: providerConfig.api_url,
        })

        register(provider)
      }
    }

    // Auto-discover: register any provider that has a key in auth.json
    // and a built-in factory, even without explicit config
    const allAuth = await Auth.all()
    for (const [providerId, authInfo] of Object.entries(allAuth)) {
      if (providers.has(providerId)) continue // Already registered from config
      if (authInfo.type !== "api") continue

      const factory = BUILTIN_FACTORIES[providerId]
      if (!factory) continue

      log.info("auto-registering asset provider from auth.json", { id: providerId })
      const provider = factory({ apiKey: authInfo.key })
      register(provider)
    }

    log.info("asset providers initialized", {
      count: providers.size,
      ids: Array.from(providers.keys()),
    })
  }

  // ── Runtime Configuration ─────────────────────────────────────────────

  /**
   * Configure and register a provider at runtime with a direct API key.
   * Used by the Settings dialog and /connect chat command.
   */
  export async function configureProvider(
    providerId: string,
    apiKey: string,
    apiUrl?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const factory = BUILTIN_FACTORIES[providerId]
    if (!factory) {
      return { success: false, error: `Unknown provider: ${providerId}` }
    }

    const provider = factory({ apiKey, apiUrl })

    // Validate the key if the provider supports it
    if ("validateApiKey" in provider && typeof (provider as any).validateApiKey === "function") {
      const valid = await (provider as any).validateApiKey()
      if (!valid) {
        return { success: false, error: "Invalid API key" }
      }
    }

    register(provider)
    log.info("asset provider configured at runtime", { id: providerId })
    return { success: true }
  }

  /** Get status of all registered providers (with masked keys for display) */
  export function status(): Array<{ id: string; name: string; supportedTypes: AssetProvider.AssetType[] }> {
    return Array.from(providers.values()).map((p) => ({
      id: p.id,
      name: p.name,
      supportedTypes: p.supportedTypes,
    }))
  }

  // ── Model Discovery ──────────────────────────────────────────────────

  export async function listModels(providerId: string): Promise<AssetProvider.ModelInfo[]> {
    const cached = modelCache.get(providerId)
    if (cached) return cached

    const provider = providers.get(providerId)
    if (!provider) {
      throw new Error(`Asset provider not found: ${providerId}`)
    }

    const models = await provider.listModels()
    modelCache.set(providerId, models)
    return models
  }

  export async function listAllModels(): Promise<Record<string, AssetProvider.ModelInfo[]>> {
    const result: Record<string, AssetProvider.ModelInfo[]> = {}
    for (const [id] of providers) {
      result[id] = await listModels(id)
    }
    return result
  }

  // ── 3-Tier Model Resolution ──────────────────────────────────────────

  /**
   * Resolve which provider and model to use for a given asset type.
   *
   * Resolution order:
   *   1. `requestModel` — explicit per-request override (format: "provider/model" or just "model")
   *   2. Config `default_models[type]` — per-type default from opencode.jsonc
   *   3. Provider's first listed model — fallback
   */
  export async function resolveModel(
    type: AssetProvider.AssetType,
    requestModel?: string,
  ): Promise<{ provider: AssetProvider.Provider; modelId: string }> {
    // Tier 1: Per-request override
    if (requestModel) {
      // Support "provider/model" format
      if (requestModel.includes("/")) {
        const [providerId, modelId] = requestModel.split("/", 2)
        const provider = providers.get(providerId)
        if (provider) {
          return { provider, modelId }
        }
        log.warn("requested provider not found, falling through", { providerId })
      }

      // Try to find model across all providers for this type
      for (const [, provider] of providers) {
        if (!provider.supportedTypes.includes(type)) continue
        const models = await listModels(provider.id)
        if (models.some((m) => m.id === requestModel)) {
          return { provider, modelId: requestModel }
        }
      }

      log.warn("requested model not found, falling through", { model: requestModel })
    }

    // Tier 2: Config default for this type
    const config = await Config.get()
    const assetConfig = (config as any).asset_provider as
      | Record<string, AssetProvider.ProviderConfig>
      | undefined

    if (assetConfig) {
      for (const [providerId, providerConfig] of Object.entries(assetConfig)) {
        const defaultModel = providerConfig.default_models?.[type]
        if (defaultModel) {
          const provider = providers.get(providerId)
          if (provider) {
            return { provider, modelId: defaultModel }
          }
        }
      }
    }

    // Tier 3: Default provider for type → its first model
    const defaultProviderId = TYPE_PROVIDER_DEFAULTS[type]
    if (defaultProviderId) {
      const provider = providers.get(defaultProviderId)
      if (provider) {
        const models = await listModels(provider.id)
        if (models.length > 0) {
          return { provider, modelId: models[0].id }
        }
      }
    }

    // Last resort: any provider that supports this type
    for (const [, provider] of providers) {
      if (provider.supportedTypes.includes(type)) {
        const models = await listModels(provider.id)
        if (models.length > 0) {
          return { provider, modelId: models[0].id }
        }
      }
    }

    throw new Error(
      `No asset provider available for type "${type}". Configure providers in opencode.jsonc under "asset_provider".`,
    )
  }

  // ── Convenience ──────────────────────────────────────────────────────

  /** Get all asset types supported across all registered providers */
  export function supportedTypes(): AssetProvider.AssetType[] {
    const types = new Set<AssetProvider.AssetType>()
    for (const [, provider] of providers) {
      for (const t of provider.supportedTypes) {
        types.add(t)
      }
    }
    return Array.from(types)
  }

  /** Find providers that support a given transform type */
  export function findTransformProviders(transform: AssetProvider.TransformType): AssetProvider.Provider[] {
    return Array.from(providers.values()).filter((p) => p.supportsTransform(transform))
  }

  /** Clear model cache (e.g., after config change) */
  export function clearCache(): void {
    modelCache.clear()
  }

  /** Reset all state (for testing) */
  export function reset(): void {
    providers.clear()
    modelCache.clear()
  }
}
