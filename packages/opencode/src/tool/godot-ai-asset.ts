import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { AssetMetadata } from "../provider/asset/metadata"
import { AssetProviderRegistry } from "../provider/asset"
import type { AssetProvider } from "../provider/asset/asset-provider"

// =============================================================================
// godot_asset_generate - Generate any asset type via configured provider
// =============================================================================

const GENERATE_DESCRIPTION = `Generate REAL assets immediately using AI providers (requires provider configuration).

IMPORTANT: Do NOT use this tool for normal game development. Use godot_asset_create_placeholder instead.

ONLY use this tool when:
- User explicitly says "generate REAL assets NOW" or "generate with AI NOW"
- AI providers are already configured
- User has confirmed they want to wait for real AI generation (slow, costs money)

For normal game development, ALWAYS use godot_asset_create_placeholder to create placeholders first.`

export const GodotAssetGenerateTool = Tool.define("godot_asset_generate", {
  description: GENERATE_DESCRIPTION,
  parameters: z.object({
    type: z
      .enum([
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
      .describe("Type of asset to generate"),
    prompt: z.string().describe("Text description of the desired asset"),
    negative_prompt: z.string().optional().describe("What to avoid in the generation"),
    destination: z.string().describe('Where to save the asset (e.g., "res://assets/")'),
    provider: z.string().optional().describe("Override the default provider for this type"),
    model: z.string().optional().describe("Override the default model for this type"),
    parameters: z.record(z.string(), z.any()).optional().describe("Provider-specific parameters"),
  }),
  async execute(params, ctx) {
    // 1. Resolve provider + model
    const resolved = await AssetProviderRegistry.resolveModel(
      params.type as AssetProvider.AssetType,
      params.model,
    )
    if (!resolved) {
      return {
        title: "Generation failed",
        metadata: { error: "no_provider" },
        output: `Error: No provider configured for asset type "${params.type}"`,
      }
    }

    const { provider, modelId } = resolved

    // 2. Start generation
    ctx.metadata({ title: `Generating ${params.type}...` })

    const result = await provider.generate({
      type: params.type as AssetProvider.AssetType,
      prompt: params.prompt,
      negativePrompt: params.negative_prompt,
      model: modelId,
      parameters: params.parameters ?? {},
    })

    // 3. Poll until complete
    let status = result
    while (status.status === "pending" || status.status === "processing") {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      status = await provider.checkStatus(result.generationId)

      if (ctx.abort.aborted) {
        return {
          title: "Generation cancelled",
          metadata: { generationId: result.generationId },
          output: "Generation was cancelled by user",
        }
      }
    }

    if (status.status === "failed") {
      return {
        title: "Generation failed",
        metadata: { generationId: result.generationId, error: status.message },
        output: `Generation failed: ${status.message || "Unknown error"}`,
      }
    }

    // 4. Download bundle
    const bundle = await provider.download(result.generationId)

    // 5. Import all assets in bundle
    const projectRoot = Instance.directory
    let destDir = params.destination
    if (destDir.startsWith("res://")) {
      destDir = path.join(projectRoot, destDir.slice(6))
    }
    await fs.mkdir(destDir, { recursive: true })

    const importedPaths: string[] = []

    for (const asset of bundle.assets) {
      const destPath = path.join(destDir, asset.filename)
      await fs.writeFile(destPath, asset.data)

      const relPath = path.relative(projectRoot, destPath)
      const resPath = `res://${relPath.replace(/\\/g, "/")}`
      importedPaths.push(resPath)

      // Write generation metadata
      const metadata: AssetProvider.AssetMetadata = {
        origin: "generated",
        asset_type: asset.type,
        prompt: params.prompt,
        negative_prompt: params.negative_prompt,
        provider: provider.id,
        model: modelId,
        generation_id: result.generationId,
        parameters: params.parameters,
        created_at: new Date().toISOString(),
        version: 1,
        bundle_id: bundle.assets.length > 1 ? bundle.bundleId : undefined,
        bundle_role: bundle.assets.length > 1 ? asset.role : undefined,
      }
      await AssetMetadata.write(destPath, metadata)
    }

    return {
      title: `Generated ${bundle.assets.length} asset(s)`,
      metadata: {
        generationId: result.generationId,
        provider: provider.id,
        model: modelId,
        assets: importedPaths,
        bundleId: bundle.bundleId,
      },
      output: `Generated ${bundle.assets.length} asset(s) using ${provider.id}/${modelId}\n\nAssets:\n${importedPaths.map((p) => `  - ${p}`).join("\n")}`,
    }
  },
})

// =============================================================================
// godot_asset_create_placeholder - Create placeholder with pre-filled metadata
// =============================================================================

const PLACEHOLDER_DESCRIPTION = `Creates game asset placeholders (textures, sprites, 3D models, audio) that work immediately and can be AI-generated later.

WHEN TO USE: User requests ANY game asset - textures, sprites, images, sounds, music, models, meshes, etc.

How it works:
- Creates working placeholder immediately (colored rectangle, basic mesh, silent audio)
- Stores your generation prompt for later AI generation
- User can right-click asset in Godot to generate real version with AI

DO NOT write GDScript code to generate images/textures programmatically. Use this tool instead.`

export const GodotAssetCreatePlaceholderTool = Tool.define("godot_asset_create_placeholder", {
  description: PLACEHOLDER_DESCRIPTION,
  parameters: z.object({
    type: z
      .enum([
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
      .describe("Type of asset"),
    destination: z.string().describe('Full res:// path including filename (e.g., "res://assets/knight/idle.png" for images, "res://assets/mesh.tres" for models)'),
    prompt: z.string().describe("Generation prompt to use when generating"),
    negative_prompt: z.string().optional().describe("What to avoid"),
    provider: z.string().optional().describe("Override default provider"),
    model: z.string().optional().describe("Override default model"),
    parameters: z.record(z.string(), z.any()).optional().describe("Generation parameters"),
    game_context: z.string().optional().describe("Why this asset is needed in the game"),
    category: z
      .enum(["character", "environment", "ui", "item", "effect", "skybox", "default"])
      .optional()
      .describe("Category for placeholder color"),
  }),
  async execute(params, ctx) {
    // Try to resolve provider/model, but don't fail if providers aren't configured
    // Placeholders can be created without providers - they'll be generated later
    let resolved: { provider: AssetProvider.Provider; modelId: string } | undefined
    try {
      resolved = await AssetProviderRegistry.resolveModel(
        params.type as AssetProvider.AssetType,
        params.model,
      )
    } catch (error) {
      // No providers configured - that's OK for placeholders
      ctx.metadata({ title: "Creating placeholder (providers not configured)" })
    }

    const projectRoot = Instance.directory
    let destPath = params.destination
    if (destPath.startsWith("res://")) {
      destPath = path.join(projectRoot, destPath.slice(6))
    }

    // Ensure directory exists
    await fs.mkdir(path.dirname(destPath), { recursive: true })

    // Generate placeholder content based on type
    const placeholder = generatePlaceholderContent(
      params.type as AssetProvider.AssetType,
      params.category ?? "default",
    )

    // For non-image types (model, scene, shader, etc.), the placeholder uses a
    // different extension (.tres, .tscn, .gdshader). Correct if needed.
    const requestedExt = path.extname(destPath)
    if (requestedExt !== placeholder.extension) {
      destPath = destPath.slice(0, -requestedExt.length) + placeholder.extension
    }

    // Write placeholder file
    await fs.writeFile(destPath, placeholder.content)

    // Write metadata
    const metadata: AssetProvider.AssetMetadata = {
      origin: "placeholder",
      asset_type: params.type as AssetProvider.AssetType,
      prompt: params.prompt,
      negative_prompt: params.negative_prompt,
      provider: resolved?.provider.id ?? params.provider,
      model: resolved?.modelId ?? params.model,
      parameters: params.parameters,
      game_context: params.game_context,
      created_at: new Date().toISOString(),
      created_by: "ai_assistant",
      version: 0,
    }
    await AssetMetadata.write(destPath, metadata)

    const relPath = path.relative(projectRoot, destPath)
    const resPath = `res://${relPath.replace(/\\/g, "/")}`

    return {
      title: `Created placeholder: ${path.basename(destPath)}`,
      metadata: {
        destination: destPath,
        resPath,
        type: params.type,
        prompt: params.prompt,
      },
      output: `Created ${params.type} placeholder at ${resPath}\n\nPrompt: "${params.prompt}"\nGenerate later with right-click → "Generate from Placeholder" or /generate-assets`,
    }
  },
})

// =============================================================================
// godot_asset_regenerate - Regenerate from stored/edited prompt
// =============================================================================

const REGENERATE_DESCRIPTION = `Regenerate an AI-generated asset with an updated prompt or new seed.

Use when the user wants to:
- Iterate on a generated asset with a modified prompt
- Get a new variation with a different seed
- Try a different model for the same prompt`

export const GodotAssetRegenerateTool = Tool.define("godot_asset_regenerate", {
  description: REGENERATE_DESCRIPTION,
  parameters: z.object({
    path: z.string().describe("res:// path to the asset to regenerate"),
    prompt: z.string().optional().describe("New prompt (omit to use stored prompt)"),
    negative_prompt: z.string().optional().describe("New negative prompt"),
    model: z.string().optional().describe("Override model for this regeneration"),
    seed: z.number().optional().describe("Specific seed (-1 for same, omit for random)"),
    parameters: z.record(z.string(), z.any()).optional().describe("Override parameters"),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory
    let assetPath = params.path
    if (assetPath.startsWith("res://")) {
      assetPath = path.join(projectRoot, assetPath.slice(6))
    }

    // 1. Read existing metadata
    const existingMeta = await AssetMetadata.read(assetPath)
    if (!existingMeta) {
      return {
        title: "Regeneration failed",
        metadata: { error: "no_metadata" },
        output: `Error: No AI metadata found for ${params.path}`,
      }
    }

    if (existingMeta.origin === "imported") {
      return {
        title: "Regeneration failed",
        metadata: { error: "imported_asset" },
        output: `Error: Cannot regenerate an imported asset. Use "AI Enhance" for transforms instead.`,
      }
    }

    // 2. Merge parameters
    const providerId = existingMeta.provider
    const provider = AssetProviderRegistry.get(providerId!)
    if (!provider) {
      return {
        title: "Regeneration failed",
        metadata: { error: "provider_not_found" },
        output: `Error: Provider "${providerId}" not found`,
      }
    }

    const prompt = params.prompt ?? existingMeta.prompt!
    const negativePrompt = params.negative_prompt ?? existingMeta.negative_prompt
    const modelId = params.model ?? existingMeta.model!
    const mergedParams = { ...existingMeta.parameters, ...params.parameters }

    // 3. Generate
    ctx.metadata({ title: `Regenerating ${path.basename(assetPath)}...` })

    const result = await provider.generate({
      type: existingMeta.asset_type!,
      prompt,
      negativePrompt,
      model: modelId,
      parameters: mergedParams,
    })

    // 4. Poll
    let status = result
    while (status.status === "pending" || status.status === "processing") {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      status = await provider.checkStatus(result.generationId)
    }

    if (status.status === "failed") {
      return {
        title: "Regeneration failed",
        metadata: { error: status.message },
        output: `Regeneration failed: ${status.message}`,
      }
    }

    // 5. Save current version before replacing
    await AssetMetadata.saveVersion(assetPath)

    // 6. Download and replace
    const bundle = await provider.download(result.generationId)
    const destDir = path.dirname(assetPath)

    const newVersion = (existingMeta.version ?? 1) + 1

    for (const asset of bundle.assets) {
      const destPath = path.join(destDir, asset.filename)
      await fs.writeFile(destPath, asset.data)

      const metadata: AssetProvider.AssetMetadata = {
        ...existingMeta,
        prompt,
        negative_prompt: negativePrompt,
        model: modelId,
        parameters: mergedParams,
        generation_id: result.generationId,
        version: newVersion,
        previous_prompt: existingMeta.prompt !== prompt ? existingMeta.prompt : undefined,
      }
      await AssetMetadata.write(destPath, metadata)
    }

    return {
      title: `Regenerated (v${newVersion})`,
      metadata: {
        path: params.path,
        version: newVersion,
        prompt,
        model: modelId,
      },
      output: `Regenerated ${params.path} (v${newVersion}) using ${providerId}/${modelId}\n\nPrompt: "${prompt}"`,
    }
  },
})

// =============================================================================
// godot_asset_transform - AI-enhance an existing asset (hybrid workflow)
// =============================================================================

const TRANSFORM_DESCRIPTION = `Apply an AI transform to an existing asset (upscale, style transfer, variation, img2model).

Use when the user wants to enhance or transform an imported/generated asset.`

export const GodotAssetTransformTool = Tool.define("godot_asset_transform", {
  description: TRANSFORM_DESCRIPTION,
  parameters: z.object({
    source: z.string().describe("res:// path to the existing asset"),
    transform: z
      .enum(["upscale", "style_transfer", "variation", "img2model", "remix"])
      .describe("Type of transform"),
    prompt: z.string().optional().describe("Guidance for the transform"),
    destination: z.string().optional().describe("Output path (defaults to same directory)"),
    provider: z.string().optional().describe("Override provider"),
    model: z.string().optional().describe("Override model"),
    parameters: z.record(z.string(), z.any()).optional().describe("Transform parameters"),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory
    let sourcePath = params.source
    if (sourcePath.startsWith("res://")) {
      sourcePath = path.join(projectRoot, sourcePath.slice(6))
    }

    // Read source file
    const sourceData = await fs.readFile(sourcePath)
    const sourceInfo = await AssetMetadata.getFileInfo(sourcePath)

    if (!sourceInfo.type) {
      return {
        title: "Transform failed",
        metadata: { error: "unknown_type" },
        output: `Error: Could not detect asset type for ${params.source}`,
      }
    }

    // Find provider that supports this transform
    const providers = AssetProviderRegistry.findTransformProviders(
      params.transform as AssetProvider.TransformType,
    )

    if (providers.length === 0) {
      return {
        title: "Transform failed",
        metadata: { error: "no_provider" },
        output: `Error: No provider supports "${params.transform}" transform`,
      }
    }

    const provider = providers[0]
    // Use provided model or get first available model from provider
    let modelId = params.model
    if (!modelId) {
      const models = await provider.listModels()
      modelId = models.length > 0 ? models[0].id : ""
    }

    // Execute transform
    ctx.metadata({ title: `Transforming (${params.transform})...` })

    const result = await provider.transform!({
      sourceFile: sourceData,
      sourceType: sourceInfo.type,
      transform: params.transform as AssetProvider.TransformType,
      prompt: params.prompt,
      model: modelId,
      parameters: params.parameters ?? {},
    })

    // Poll
    let status = result
    while (status.status === "pending" || status.status === "processing") {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      status = await provider.checkStatus(result.generationId)
    }

    if (status.status === "failed") {
      return {
        title: "Transform failed",
        metadata: { error: status.message || "Unknown error" },
        output: `Transform failed: ${status.message || "Unknown error"}`,
      }
    }

    // Download and save
    const bundle = await provider.download(result.generationId)
    const destDir = params.destination
      ? params.destination.startsWith("res://")
        ? path.join(projectRoot, params.destination.slice(6))
        : params.destination
      : path.dirname(sourcePath)

    await fs.mkdir(destDir, { recursive: true })

    const importedPaths: string[] = []

    for (const asset of bundle.assets) {
      const destPath = path.join(destDir, asset.filename)
      await fs.writeFile(destPath, asset.data)

      const relPath = path.relative(projectRoot, destPath)
      const resPath = `res://${relPath.replace(/\\/g, "/")}`
      importedPaths.push(resPath)

      const metadata: AssetProvider.AssetMetadata = {
        origin: "hybrid",
        asset_type: asset.type,
        source_asset: params.source,
        transform: params.transform,
        prompt: params.prompt,
        provider: provider.id,
        model: modelId,
        generation_id: result.generationId,
        created_at: new Date().toISOString(),
        version: 1,
      }
      await AssetMetadata.write(destPath, metadata)
    }

    return {
      title: `Transformed via ${params.transform}`,
      metadata: {
        source: params.source,
        transform: params.transform,
        outputs: importedPaths,
      },
      output: `Applied ${params.transform} to ${params.source}\n\nOutputs:\n${importedPaths.map((p) => `  - ${p}`).join("\n")}`,
    }
  },
})

// =============================================================================
// godot_asset_refine_prompt - AI-assisted prompt refinement
// =============================================================================

const REFINE_PROMPT_DESCRIPTION = `Use AI to refine/improve a generation prompt based on user instruction.

Use when the user wants to modify a prompt in natural language, e.g., "make it more cartoon-like".`

export const GodotAssetRefinePromptTool = Tool.define("godot_asset_refine_prompt", {
  description: REFINE_PROMPT_DESCRIPTION,
  parameters: z.object({
    path: z.string().optional().describe("res:// path to asset (reads stored prompt)"),
    prompt: z.string().optional().describe("Explicit prompt to refine (overrides reading from asset)"),
    instruction: z.string().describe('What to change, e.g., "add a shield" or "make it low-poly"'),
  }),
  async execute(params, ctx) {
    let currentPrompt = params.prompt

    if (!currentPrompt && params.path) {
      const projectRoot = Instance.directory
      let assetPath = params.path
      if (assetPath.startsWith("res://")) {
        assetPath = path.join(projectRoot, assetPath.slice(6))
      }
      const meta = await AssetMetadata.read(assetPath)
      currentPrompt = meta?.prompt
    }

    if (!currentPrompt) {
      return {
        title: "Refine failed",
        metadata: { error: "no_prompt" },
        output: "Error: No prompt provided or found in asset metadata",
      }
    }

    // The refined prompt would normally be generated by the LLM in the conversation
    // For now, we return the original with the instruction appended
    // The actual refinement happens in the conversation context
    const refinedPrompt = `${currentPrompt}. ${params.instruction}`

    return {
      title: "Prompt refined",
      metadata: {
        original_prompt: currentPrompt,
        instruction: params.instruction,
        refined_prompt: refinedPrompt,
      },
      output: `Original: "${currentPrompt}"\nInstruction: "${params.instruction}"\n\nRefined: "${refinedPrompt}"`,
    }
  },
})

// =============================================================================
// godot_asset_list_models - List available models
// =============================================================================

export const GodotAssetListModelsTool = Tool.define("godot_asset_list_models", {
  description: "List available AI models for asset generation, optionally filtered by provider or type.",
  parameters: z.object({
    provider: z.string().optional().describe("Filter by provider (e.g., meshy, doubao, suno)"),
    type: z
      .enum(["texture", "model", "audio_sfx", "audio_music", "shader", "font"])
      .optional()
      .describe("Filter by asset type"),
  }),
  async execute(params, ctx) {
    if (params.provider) {
      const models = await AssetProviderRegistry.listModels(params.provider)
      return {
        title: `Models for ${params.provider}`,
        metadata: { provider: params.provider, count: models.length },
        output: JSON.stringify(models, null, 2),
      }
    }

    const allModels = await AssetProviderRegistry.listAllModels()

    if (params.type) {
      // Filter to models that support this type
      const filtered: Record<string, AssetProvider.ModelInfo[]> = {}
      for (const [pid, models] of Object.entries(allModels)) {
        const matching = models.filter((m) => m.supportedTypes.includes(params.type as AssetProvider.AssetType))
        if (matching.length > 0) {
          filtered[pid] = matching
        }
      }
      return {
        title: `Models for ${params.type}`,
        metadata: { type: params.type },
        output: JSON.stringify(filtered, null, 2),
      }
    }

    return {
      title: "All AI models",
      metadata: { providers: Object.keys(allModels) },
      output: JSON.stringify(allModels, null, 2),
    }
  },
})

// =============================================================================
// Helper: Generate placeholder content
// =============================================================================

function generatePlaceholderContent(
  type: AssetProvider.AssetType,
  category: string,
): { content: Buffer; extension: string } {
  // Color map for placeholder textures (0-255 RGBA)
  const categoryColors: Record<string, [number, number, number, number]> = {
    character: [255, 0, 255, 255], // Magenta
    environment: [0, 204, 0, 255], // Green
    ui: [0, 255, 255, 255], // Cyan
    item: [255, 128, 0, 255], // Orange
    effect: [255, 255, 0, 255], // Yellow
    skybox: [51, 102, 255, 255], // Blue
    default: [153, 153, 153, 255], // Gray
  }

  const color = categoryColors[category] ?? categoryColors.default

  switch (type) {
    case "texture":
    case "sprite":
    case "cubemap": {
      // Generate a real 64x64 PNG with the category color
      return { content: generateSolidPNG(64, 64, color), extension: ".png" }
    }

    case "model":
    case "mesh": {
      // BoxMesh placeholder (native Godot resource)
      const tres = `[gd_resource type="BoxMesh" format=3]

[resource]
size = Vector3(1, 1, 1)
`
      return { content: Buffer.from(tres), extension: ".tres" }
    }

    case "scene": {
      // Simple scene with MeshInstance3D
      const tscn = `[gd_scene format=3]

[sub_resource type="BoxMesh" id="1"]

[node name="Placeholder" type="MeshInstance3D"]
mesh = SubResource("1")
`
      return { content: Buffer.from(tscn), extension: ".tscn" }
    }

    case "audio_sfx":
    case "audio_music": {
      // Empty audio stream (native Godot resource)
      const tres = `[gd_resource type="AudioStreamGenerator" format=3]

[resource]
`
      return { content: Buffer.from(tres), extension: ".tres" }
    }

    case "shader": {
      const colorF = color.map((c) => (c / 255).toFixed(2))
      const gdshader = `shader_type spatial;

void fragment() {
    ALBEDO = vec3(${colorF[0]}, ${colorF[1]}, ${colorF[2]});
}
`
      return { content: Buffer.from(gdshader), extension: ".gdshader" }
    }

    case "material": {
      const colorF = color.map((c) => (c / 255).toFixed(2))
      const tres = `[gd_resource type="StandardMaterial3D" format=3]

[resource]
albedo_color = Color(${colorF.join(", ")})
`
      return { content: Buffer.from(tres), extension: ".tres" }
    }

    case "font": {
      const tres = `[gd_resource type="SystemFont" format=3]

[resource]
`
      return { content: Buffer.from(tres), extension: ".tres" }
    }

    default: {
      return { content: Buffer.from(""), extension: ".txt" }
    }
  }
}

/** Generate a minimal valid PNG file filled with a solid RGBA color. */
function generateSolidPNG(
  width: number,
  height: number,
  color: [number, number, number, number],
): Buffer {
  const { deflateSync } = require("zlib") as typeof import("zlib")

  // Build raw image data: filter byte (0) + RGBA pixels per row
  const rowSize = 1 + width * 4
  const rawData = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    const offset = y * rowSize
    rawData[offset] = 0 // No filter
    for (let x = 0; x < width; x++) {
      const px = offset + 1 + x * 4
      rawData[px] = color[0]
      rawData[px + 1] = color[1]
      rawData[px + 2] = color[2]
      rawData[px + 3] = color[3]
    }
  }

  const compressed = deflateSync(rawData)

  // PNG chunks
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR: width, height, bit depth 8, color type 6 (RGBA)
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // color type: RGBA
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // interlace
  const ihdr = pngChunk("IHDR", ihdrData)

  const idat = pngChunk("IDAT", compressed)
  const iend = pngChunk("IEND", Buffer.alloc(0))

  return Buffer.concat([signature, ihdr, idat, iend])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, "ascii")
  const crcInput = Buffer.concat([typeBuffer, data])
  const crcValue = Buffer.alloc(4)
  // Use a simple CRC32 implementation for PNG chunks
  crcValue.writeUInt32BE(crc32PNG(crcInput) >>> 0, 0)
  return Buffer.concat([length, typeBuffer, data, crcValue])
}

/** CRC32 for PNG (ISO 3309 / ITU-T V.42) */
function crc32PNG(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
