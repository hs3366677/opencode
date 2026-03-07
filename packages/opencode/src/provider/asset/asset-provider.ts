import z from "zod"

export namespace AssetProvider {
  // ── Asset Types ──────────────────────────────────────────────────────

  export const AssetType = z.enum([
    "texture",
    "sprite",
    "cubemap",
    "model",
    "mesh",
    "scene",
    "audio_sfx",
    "audio_music",
    "shader",
    "material",
    "font",
  ])
  export type AssetType = z.infer<typeof AssetType>

  // ── Origin Tracking ──────────────────────────────────────────────────

  export const Origin = z.enum(["placeholder", "imported", "generated", "hybrid"])
  export type Origin = z.infer<typeof Origin>

  // ── Placeholder Categories (for texture color mapping) ───────────────

  export const PlaceholderCategory = z.enum([
    "character",
    "environment",
    "ui",
    "item",
    "effect",
    "skybox",
    "default",
  ])
  export type PlaceholderCategory = z.infer<typeof PlaceholderCategory>

  /** Category → RGBA color for placeholder GradientTexture2D */
  export const PLACEHOLDER_COLORS: Record<PlaceholderCategory, [number, number, number, number]> = {
    character: [1, 0, 1, 1], // Magenta
    environment: [0, 0.8, 0, 1], // Green
    ui: [0, 1, 1, 1], // Cyan
    item: [1, 0.5, 0, 1], // Orange
    effect: [1, 1, 0, 1], // Yellow
    skybox: [0.2, 0.4, 1, 1], // Blue
    default: [0.6, 0.6, 0.6, 1], // Gray
  }

  // ── Transform Types ──────────────────────────────────────────────────

  export const TransformType = z.enum([
    "upscale",
    "style_transfer",
    "variation",
    "img2model",
    "remix",
  ])
  export type TransformType = z.infer<typeof TransformType>

  // ── Model Discovery ──────────────────────────────────────────────────

  export const ModelParameterDef = z.object({
    name: z.string(),
    type: z.enum(["string", "number", "boolean", "enum"]),
    description: z.string(),
    default: z.any(),
    options: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  export type ModelParameterDef = z.infer<typeof ModelParameterDef>

  export const ModelInfo = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    supportedTypes: z.array(AssetType),
    supportedTransforms: z.array(TransformType).optional(),
    parameters: z.array(ModelParameterDef).optional(),
    pricing: z
      .object({
        unit: z.string(),
        cost: z.number(),
      })
      .optional(),
  })
  export type ModelInfo = z.infer<typeof ModelInfo>

  // ── Generation Request / Result ──────────────────────────────────────

  export const GenerationRequest = z.object({
    type: AssetType,
    prompt: z.string(),
    negativePrompt: z.string().optional(),
    model: z.string().optional(),
    parameters: z.record(z.string(), z.any()).default({}),
  })
  export type GenerationRequest = z.infer<typeof GenerationRequest>

  export const GenerationResult = z.object({
    generationId: z.string(),
    status: z.enum(["pending", "processing", "completed", "failed"]),
    estimatedTime: z.number().optional(),
  })
  export type GenerationResult = z.infer<typeof GenerationResult>

  export const GenerationStatus = GenerationResult.extend({
    progress: z.number().min(0).max(100).optional(),
    message: z.string().optional(),
  })
  export type GenerationStatus = z.infer<typeof GenerationStatus>

  // ── Asset Bundle ─────────────────────────────────────────────────────

  export const BundleAsset = z.object({
    type: AssetType,
    role: z.enum(["primary", "material", "texture", "animation"]),
    data: z.instanceof(Buffer),
    filename: z.string(),
    metadata: z.record(z.string(), z.any()).default({}),
  })
  export type BundleAsset = z.infer<typeof BundleAsset>

  export const AssetBundle = z.object({
    bundleId: z.string(),
    assets: z.array(BundleAsset),
  })
  export type AssetBundle = z.infer<typeof AssetBundle>

  // ── Transform Request ────────────────────────────────────────────────

  export const TransformRequest = z.object({
    sourceFile: z.instanceof(Buffer),
    sourceType: AssetType,
    transform: TransformType,
    prompt: z.string().optional(),
    model: z.string().optional(),
    parameters: z.record(z.string(), z.any()).default({}),
  })
  export type TransformRequest = z.infer<typeof TransformRequest>

  // ── Provider Interface ───────────────────────────────────────────────

  export interface Provider {
    readonly id: string
    readonly name: string
    readonly supportedTypes: AssetType[]

    /** Discover available models from this provider */
    listModels(): Promise<ModelInfo[]>

    /** Start an asset generation job */
    generate(request: GenerationRequest): Promise<GenerationResult>

    /** Poll generation status */
    checkStatus(generationId: string): Promise<GenerationStatus>

    /** Download completed generation as a bundle */
    download(generationId: string): Promise<AssetBundle>

    /** Check if provider supports a specific transform */
    supportsTransform(transform: TransformType): boolean

    /** Apply a transform to an existing asset */
    transform(request: TransformRequest): Promise<GenerationResult>
  }

  // ── Asset Metadata (stored in .ai.{filename}/metadata.json) ─────────

  export const AssetMetadata = z.object({
    origin: Origin,
    asset_type: AssetType,
    prompt: z.string().optional(),
    negative_prompt: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    generation_id: z.string().optional(),
    seed: z.number().optional(),
    parameters: z.record(z.string(), z.any()).optional(),
    category: PlaceholderCategory.optional(),
    usage: z
      .object({
        scene: z.string().optional().describe("Scene where the asset is used, e.g. res://scenes/battle.tscn"),
        node_path: z.string().optional().describe("Node path in the scene, e.g. Player/Sprite2D"),
        role: z.string().describe("What role this asset plays in the game, e.g. 'player idle sprite'"),
        width: z.number().int().positive().optional().describe("Required width in pixels"),
        height: z.number().int().positive().optional().describe("Required height in pixels"),
        transparent_bg: z.boolean().default(true).describe("Whether the asset needs a transparent background"),
        scale: z.string().optional().describe("Rendering scale: '1x', '2x', 'pixel-perfect'"),
        tiling: z.enum(["none", "horizontal", "vertical", "both"]).default("none").describe("Tiling mode"),
        animation_frames: z.number().int().optional().describe("Number of frames if sprite sheet"),
      })
      .optional(),
    created_at: z.string().optional(),
    imported_from: z.string().optional(),
    original_filename: z.string().optional(),
    transform_source: z.string().optional(),
    transform_type: TransformType.optional(),
    version: z.number().default(1),
    version_history: z
      .array(
        z.object({
          version: z.number(),
          prompt: z.string().optional(),
          model: z.string().optional(),
          seed: z.number().optional(),
          timestamp: z.string(),
          file: z.string().optional(),
        }),
      )
      .optional(),
    post_processing: z
      .array(
        z.object({
          operation: z.string(),
          params: z.record(z.string(), z.any()).optional(),
          timestamp: z.string(),
        }),
      )
      .optional(),
  })
  export type AssetMetadata = z.infer<typeof AssetMetadata>

  // ── Provider Config (for opencode.jsonc) ─────────────────────────────

  export const ProviderConfig = z.object({
    api_key_env: z.string().optional().describe("Environment variable name for API key"),
    api_key: z.string().optional().describe("Direct API key (synced from editor settings)"),
    api_url: z.string().optional().describe("Override base API URL"),
    enabled: z.boolean().default(true),
    default_models: z
      .record(AssetType, z.string())
      .optional()
      .describe("Default model per asset type for this provider"),
  })
  export type ProviderConfig = z.infer<typeof ProviderConfig>
}
