import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { AssetMetadata } from "../provider/asset/metadata"
import { AssetProviderRegistry } from "../provider/asset"
import type { AssetProvider } from "../provider/asset/asset-provider"
import { readProfile, writeProfile } from "../provider/asset/style-profile"
import type { StyleProfile } from "../provider/asset/style-profile"
import { getModelDefaults } from "../config/model-defaults"
import { getImageModel } from "../server/routes/ai-assets"
import { generateImage } from "../provider/asset/generate-image"
import { GodotAssetPipelineTool } from "./godot-asset-pipeline"

// =============================================================================
// godot_asset_generate - Low-level generation (not registered; use godot_asset_pipeline instead)
// =============================================================================

const GENERATE_DESCRIPTION = `Low-level asset generation without quality control. Not registered — kept for internal reuse by other tools.`

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
    style_reference: z.string().optional().describe("res:// path to override the project style reference image"),
    use_project_style: z.boolean().optional().describe("Set to false to skip auto-injecting project style profile (default: true)"),
  }),
  async execute(params, ctx) {
    // 0. Inject project style profile (if available and not explicitly disabled)
    let effectivePrompt = params.prompt
    let effectiveModel = params.model
    let effectiveParameters = params.parameters ?? {}

    if (params.use_project_style !== false) {
      const projectRoot = Instance.directory
      const profile = readProfile(projectRoot)
      if (profile) {
        // Prepend art direction to prompt
        if (profile.art_direction) {
          effectivePrompt = `${profile.art_direction}. ${effectivePrompt}`
        }
        // Inject reference image for consistency (prefer explicit override)
        const refAsset = params.style_reference ?? profile.reference_asset
        if (refAsset && !effectiveParameters.input_image) {
          effectiveParameters = { ...effectiveParameters, input_image: refAsset }
        }
        // Use consistency model if no model specified
        if (!effectiveModel && profile.consistency_model) {
          effectiveModel = profile.consistency_model
        }
      }
    }

    // 1. Resolve provider + model (use effectiveModel which may have been set from profile)
    const resolved = await AssetProviderRegistry.resolveModel(
      params.type as AssetProvider.AssetType,
      effectiveModel,
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
      prompt: effectivePrompt,
      negativePrompt: params.negative_prompt,
      model: modelId,
      parameters: effectiveParameters,
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
        prompt: effectivePrompt,
        negative_prompt: params.negative_prompt,
        provider: provider.id,
        model: modelId,
        generation_id: result.generationId,
        parameters: effectiveParameters,
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
    destination: z.string().describe('Full res:// path including filename (e.g., "res://assets/knight/idle.png" for images, "res://assets/knight/mesh/model.glb" for 3D models)'),
    prompt: z.string().describe("Generation prompt to use when generating"),
    negative_prompt: z.string().optional().describe("What to avoid"),
    provider: z.string().optional().describe("Override default provider"),
    model: z.string().optional().describe("Override default model"),
    parameters: z.record(z.string(), z.any()).optional().describe("Generation parameters"),
    usage: z
      .object({
        role: z.string().describe("What role this asset plays in the game, e.g. 'player idle sprite', 'ground tile'"),
        scene: z.string().optional().describe("Scene where used, e.g. res://scenes/battle.tscn"),
        node_path: z.string().optional().describe("Node path, e.g. Player/Sprite2D"),
        width: z.number().int().positive().optional().describe("Required width in pixels"),
        height: z.number().int().positive().optional().describe("Required height in pixels"),
        transparent_bg: z.boolean().default(true).describe("Needs transparent background"),
        scale: z.string().optional().describe("Rendering scale: '1x', '2x', 'pixel-perfect'"),
        tiling: z.enum(["none", "horizontal", "vertical", "both"]).default("none").describe("Tiling mode"),
        animation_frames: z.number().int().optional().describe("Number of frames if sprite sheet"),
      })
      .optional()
      .describe("Usage declaration: where/how this asset is used in the game. Write-once — guides all future generation."),
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

    // Generate placeholder content based on type (use usage dimensions if available)
    const placeholder = generatePlaceholderContent(
      params.type as AssetProvider.AssetType,
      params.category ?? "default",
      params.usage?.width,
      params.usage?.height,
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
      model: resolved?.modelId ?? params.model ?? await getImageModel(),
      parameters: params.parameters,
      usage: params.usage,
      created_at: new Date().toISOString(),
      version: 0,
    }
    await AssetMetadata.write(destPath, metadata)

    const relPath = path.relative(projectRoot, destPath)
    const resPath = `res://${relPath.replace(/\\/g, "/")}`

    const usageSummary = params.usage
      ? `\nUsage: ${params.usage.role}${params.usage.width && params.usage.height ? ` (${params.usage.width}x${params.usage.height})` : ""}${params.usage.transparent_bg ? ", transparent" : ""}${params.usage.scene ? `, in ${params.usage.scene}` : ""}`
      : ""

    return {
      title: `Created placeholder: ${path.basename(destPath)}`,
      metadata: {
        destination: destPath,
        resPath,
        type: params.type,
        prompt: params.prompt,
        usage: params.usage,
      },
      output: `Created ${params.type} placeholder at ${resPath}\n\nPrompt: "${params.prompt}"${usageSummary}\nGenerate later with godot_asset_pipeline or /generate-asset`,
    }
  },
})

// =============================================================================
// godot_asset_regenerate - Regenerate from stored/edited prompt
// =============================================================================

const REGENERATE_DESCRIPTION = `Low-level regeneration without quality control. PREFER godot_asset_pipeline instead.

IMPORTANT: Use godot_asset_pipeline for regeneration — it includes post-processing and quality scoring with auto-retry. Pass the same destination path to overwrite the existing asset.

Only use this tool when you specifically need to preserve version history and iterate with seed control.`

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
// godot_worldbuilding - Save worldbuilding dialogue results
// =============================================================================

const WORLDBUILDING_DESCRIPTION = `Save the worldbuilding results from the conversation to docs/worldbuilding.md.

Call this AFTER completing the 3-question worldbuilding dialogue with the user.
This tool saves a structured world bible and returns a condensed visual prompt
that godot_art_explore will use to generate world-specific concept art.

Do NOT call this before asking the user the worldbuilding questions.`

export const GodotWorldbuildingTool = Tool.define("godot_worldbuilding", {
  description: WORLDBUILDING_DESCRIPTION,
  parameters: z.object({
    world_name: z.string().describe("Name of this game world"),
    central_lie: z.string().describe("The world's biggest lie — official narrative vs hidden truth"),
    core_tension: z.string().describe("The fundamental conflict arising from the lie"),
    protagonist_hook: z.string().describe("Specific personal situation forcing the protagonist to act"),
    world_rule: z.string().describe("The world's most unique currency, law, or mechanic"),
    key_imagery: z.array(z.string()).describe("5-7 specific visual objects/symbols from this world"),
    sensory_signature: z.string().describe("Dominant sensory impression — smell, sound, temperature"),
    visual_taboos: z.array(z.string()).optional().describe("Visual elements that must NEVER appear in this world's art"),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory
    const docsDir = path.join(projectRoot, "docs")
    await fs.mkdir(docsDir, { recursive: true })

    // Build worldbuilding.md
    const sections = [
      `# ${params.world_name} — World Bible\n`,
      `## The Lie\n${params.central_lie}\n`,
      `## Core Tension\n${params.core_tension}\n`,
      `## Protagonist\n${params.protagonist_hook}\n`,
      `## World Rule\n${params.world_rule}\n`,
      `## Key Imagery\n${params.key_imagery.map((i) => `- ${i}`).join("\n")}\n`,
      `## Sensory Signature\n${params.sensory_signature}\n`,
    ]
    if (params.visual_taboos?.length) {
      sections.push(`## Visual Taboos\n${params.visual_taboos.map((t) => `- NEVER: ${t}`).join("\n")}\n`)
    }
    const md = sections.join("\n")

    const wbPath = path.join(docsDir, "worldbuilding.md")
    await fs.writeFile(wbPath, md)

    // Condensed English visual prompt for image generation
    const worldPrompt = [
      params.sensory_signature,
      `key imagery: ${params.key_imagery.join(", ")}`,
      params.visual_taboos?.length ? `forbidden: ${params.visual_taboos.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(", ")

    return {
      title: `Worldbuilding saved: ${params.world_name}`,
      metadata: { world_name: params.world_name, world_prompt: worldPrompt },
      output: `Saved worldbuilding to docs/worldbuilding.md\n\nVisual prompt for art explore:\n"${worldPrompt}"\n\nProceed to visual language discussion, then call godot_art_explore.`,
    }
  },
})

// =============================================================================
// godot_art_explore - Generate multi-style gameplay scene explorations
// =============================================================================

const ART_EXPLORE_DESCRIPTION = `Generate 4 Key Art concept images in different styles, informed by the project's worldbuilding.

IMPORTANT: Before calling this tool, the worldbuilding phase MUST be complete:
1. User answered 3 worldbuilding questions (central lie, protagonist hook, world rule)
2. godot_worldbuilding was called to save results to docs/worldbuilding.md
3. Visual language was discussed (color mood, symbols, taboos)
If docs/worldbuilding.md doesn't exist, warn the user and complete worldbuilding first.

If worldbuilding_context is not provided, reads docs/worldbuilding.md automatically.
Each image is a KEY ART concept — a gameplay scene showing characters, environment, and action.
These are NOT UI mockups. UI elements (health bars, menus, HUD) belong in Cornerstone Assets.
After generating, tell the user to check the Art Director panel to view and select a style, then use godot_art_confirm.`

export const GodotArtExploreTool = Tool.define("godot_art_explore", {
  description: ART_EXPLORE_DESCRIPTION,
  parameters: z.object({
    game_description: z.string().describe("Brief description of the game theme, e.g. 'dark dungeon card game'"),
    gameplay_mechanics: z.string().describe("Core gameplay mechanics, e.g. 'card hand + turn-based combat + dungeon exploration'"),
    num_styles: z.number().optional().describe("Number of style variants to generate (default: 4)"),
    styles: z.array(z.string()).optional().describe("Explicit style names to use (overrides auto-selection)"),
    aspect_ratio: z.string().default("16:9").describe("Image aspect ratio — choose based on game orientation. E.g. '16:9' for landscape, '9:16' for portrait/mobile"),
    model: z.string().optional().describe("Image generation model to use (default: nano-banana-2). Options: nano-banana-2, flux-2-pro, sd-3.5-medium, sd-3.5-large-turbo, sdxl"),
    worldbuilding_context: z.string().optional().describe("Condensed world visual prompt from godot_worldbuilding. If omitted, reads docs/worldbuilding.md"),
    reference_image: z.string().optional().describe("res:// path to an existing image to use as image-to-image reference. Use when regenerating or refining a previously generated style exploration."),
  }),
  async execute(params, ctx) {
    const numStyles = params.num_styles ?? 4
    const projectRoot = Instance.directory

    // Load worldbuilding context for richer prompts
    let worldContext = params.worldbuilding_context ?? ""
    if (!worldContext) {
      try {
        const wbContent = await fs.readFile(path.join(projectRoot, "docs", "worldbuilding.md"), "utf-8")
        const imageryMatch = wbContent.match(/## Key Imagery\n([\s\S]*?)(?=\n##|$)/)
        const sensoryMatch = wbContent.match(/## Sensory Signature\n([\s\S]*?)(?=\n##|$)/)
        const taboosMatch = wbContent.match(/## Visual Taboos\n([\s\S]*?)(?=\n##|$)/)
        const parts: string[] = []
        if (sensoryMatch) parts.push(sensoryMatch[1].trim())
        if (imageryMatch) {
          parts.push(
            "key imagery: " +
              imageryMatch[1]
                .replace(/^- /gm, "")
                .trim()
                .split("\n")
                .join(", "),
          )
        }
        if (taboosMatch) {
          parts.push(
            "forbidden: " +
              taboosMatch[1]
                .replace(/^- NEVER: /gm, "")
                .trim()
                .split("\n")
                .join(", "),
          )
        }
        worldContext = parts.join(", ")
      } catch {
        /* no worldbuilding yet — proceed with game_description only */
      }
    }

    // Infer scene layout template from gameplay mechanics
    const layout = inferSceneLayout(params.gameplay_mechanics)

    // Default style set for exploration (key art — no UI)
    const defaultStyles = [
      "16-bit pixel art retro key art",
      "hand-drawn ink and watercolor concept art",
      "vector flat design minimalist illustration",
      "painterly stylized concept art scene",
    ]
    const styleList = params.styles ?? defaultStyles.slice(0, numStyles)

    // Create a session subfolder with timestamp
    const sessionId = `session_${new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+/, "").replace(/(\d{8})(\d{6})/, "$1_$2")}`
    const explorationDir = path.join(projectRoot, "assets", ".art_exploration", sessionId)
    await fs.mkdir(explorationDir, { recursive: true })

    const results: Array<{ style: string; resPath: string; status: string }> = []

    ctx.metadata({ title: `Generating style explorations (0/${styleList.length})...` })

    for (let i = 0; i < styleList.length; i++) {
      const style = styleList[i]
      const prompt = buildExplorationPrompt(style, layout, params.game_description, worldContext)
      const filename = `style_${i + 1}.png`
      const destPath = path.join(explorationDir, filename)
      const resPath = `res://assets/.art_exploration/${sessionId}/${filename}`

      ctx.metadata({ title: `Generating style ${i + 1}/${styleList.length}: ${style.split(" ").slice(0, 3).join(" ")}...` })

      try {
        const result = await generateImage({
          type: "texture",
          prompt,
          model: params.model ?? await getImageModel(),
          parameters: {
            aspect_ratio: params.aspect_ratio,
            ...(params.reference_image ? { input_image: params.reference_image } : {}),
          },
          destPath,
          abortSignal: ctx.abort,
        })

        if (result.success) {
          results.push({ style, resPath, status: "ready" })
          ctx.metadata({ title: `Style ${i + 1}/${styleList.length} done ✓ — generating next...` })
        } else {
          results.push({ style, resPath, status: result.error ?? "failed" })
          ctx.metadata({ title: `Style ${i + 1}/${styleList.length} failed — continuing...` })
        }
      } catch (err: any) {
        results.push({ style, resPath, status: `error: ${err.message}` })
        ctx.metadata({ title: `Style ${i + 1}/${styleList.length} error — continuing...` })
      }
    }

    const readyCount = results.filter((r) => r.status === "ready").length
    const styleList2 = results.map((r, i) => `  Style ${i + 1} (${r.style.split(" ").slice(0, 3).join(" ")}) → ${r.resPath} [${r.status}]`).join("\n")

    return {
      title: `Generated ${readyCount}/${styleList.length} style explorations`,
      metadata: { explorations: results },
      output: `Generated ${readyCount} Key Art style explorations (${params.game_description}):\n${styleList2}\n\nEach image is a concept art scene showing the game's visual style (no UI elements — UI is generated separately in Cornerstone Assets).\nView and select your preferred style in the **Art Director** panel.\nTell me which style number you prefer (1-${styleList.length}).`,
    }
  },
})

// =============================================================================
// godot_art_refine - Iterate on a single art exploration image (img2img)
// =============================================================================

const ART_REFINE_DESCRIPTION = `Refine a single art exploration image by regenerating it with a modified prompt, using the original as a reference.

Use this after godot_art_explore when the user wants to iterate on a specific image — e.g. "remove the dragon", "add a castle in the background", "make it darker".
The original image is sent as an img2img reference so the overall composition and style are preserved while applying the requested changes.

Workflow: godot_art_explore → user picks a style → godot_art_refine (repeat until satisfied) → godot_art_confirm`

export const GodotArtRefineTool = Tool.define("godot_art_refine", {
  description: ART_REFINE_DESCRIPTION,
  parameters: z.object({
    reference_image: z.string().describe("res:// path to the image to refine — the refined result overwrites this file and a new version is saved in history"),
    prompt: z.string().describe("Full prompt describing the desired result. Include the style and scene description, plus the modifications (e.g. 'same scene but remove the dragon and add a glowing portal')"),
    strength: z.number().min(0).max(1).default(0.65).describe("How much to deviate from the reference. 0.0 = almost identical, 1.0 = ignore reference. Default 0.65. Use lower values (0.3-0.5) for small tweaks, higher (0.7-0.9) for major changes."),
    model: z.string().optional().describe("Image generation model (default: nano-banana-2)"),
    attempt: z.number().int().min(1).default(1),
    max_retries: z.number().int().min(0).default(2),
    previous_feedback: z.string().optional(),
  }),
  async execute(params, ctx) {
    let refResPath = params.reference_image
    if (!refResPath.startsWith("res://")) {
      refResPath = "res://" + refResPath
    }

    ctx.metadata({ title: `Refining: ${path.basename(refResPath)}...` })

    try {
      const pipeline = await GodotAssetPipelineTool.init()
      const result = await pipeline.execute({
        prompt: params.prompt,
        destination: refResPath,
        asset_type: "texture",
        requirements: { match_size: false, min_score: 7 },
        model: params.model ?? await getImageModel(),
        reference_image: refResPath,
        prompt_strength: params.strength,
        use_project_style: true,
        attempt: params.attempt,
        max_retries: params.max_retries,
        previous_feedback: params.previous_feedback,
        usage: {
          role: "art refinement",
          transparent_bg: false,
          tiling: "none" as const,
        },
      }, ctx)

      return {
        title: result.title ?? `Refined: ${path.basename(refResPath)}`,
        metadata: { reference: refResPath, output: refResPath, error: "" },
        output: `${result.output}\n\nView the result in the Art Director panel.\nIf you want to iterate further, call godot_art_refine again.\nWhen satisfied, call godot_art_confirm to lock in the style.`,
      }
    } catch (err: any) {
      return {
        title: "Refine failed",
        metadata: { reference: params.reference_image, output: "", error: err.message },
        output: `Error: ${err.message}`,
      }
    }
  },
})

/** Infer a gameplay scene layout description from mechanics text.
 *  These are KEY ART compositions — no UI/HUD elements. UI is generated separately in Cornerstone Assets. */
function inferSceneLayout(mechanics: string): string {
  const lower = mechanics.toLowerCase()
  if (lower.includes("card") || lower.includes("deck")) {
    return "key art: dramatic card battle scene, magical cards floating in mid-air with glowing symbols, hero character facing off against enemy creature, dungeon stone environment with atmospheric lighting"
  }
  if (lower.includes("platform") || lower.includes("jump")) {
    return "key art: side-scrolling platformer landscape, layered parallax background, platforms and terrain with environmental detail, character mid-action, collectible items scattered across the scene"
  }
  if (lower.includes("tower defense") || lower.includes("td")) {
    return "key art: top-down battlefield with winding path through terrain, defensive towers standing guard, wave of enemies approaching, environmental details and atmosphere"
  }
  if (lower.includes("rpg") || lower.includes("dungeon") || lower.includes("roguelike")) {
    return "key art: dungeon room with detailed floor tiles, hero character exploring, enemy creatures lurking, architectural walls and doorways, atmospheric lighting and shadows"
  }
  if (lower.includes("puzzle")) {
    return "key art: puzzle scene with colorful interactive elements, game pieces and objects arranged in play, environmental context, vibrant colors and clear visual hierarchy"
  }
  if (lower.includes("shoot") || lower.includes("bullet")) {
    return "key art: action shooter scene, player character in combat stance, enemy sprites and projectile patterns visible, dynamic environment with depth"
  }
  // Generic fallback
  return "key art: gameplay scene with player character in action, interactive environment elements, atmospheric background, clear visual storytelling"
}

/** Build a key art exploration prompt for a given style */
function buildExplorationPrompt(style: string, layout: string, theme: string, worldContext?: string): string {
  const worldPart = worldContext ? `${theme}, ${worldContext}` : `${theme} theme`
  return `${style}, ${worldPart}, ${layout}, no UI elements, no HUD, no health bars, no menus, no text overlays, pure gameplay scene concept art, cinematic composition`
}

// =============================================================================
// godot_art_confirm - Read chosen style image for LLM vision analysis
// =============================================================================

const ART_CONFIRM_DESCRIPTION = `Read the user's chosen style exploration image and return it for visual analysis.

After the user selects a style number from godot_art_explore results, call this tool with the chosen image path. The tool returns the image content so you (the LLM) can analyze it with vision to:
1. Extract color palette (HEX values)
2. Describe line style, lighting rules, character proportions
3. Write docs/visual_bible.md with these rules
4. Call godot_style_set to save the style profile

This tool MUST be followed by writing visual_bible.md and calling godot_style_set.`

export const GodotArtConfirmTool = Tool.define("godot_art_confirm", {
  description: ART_CONFIRM_DESCRIPTION,
  parameters: z.object({
    chosen_path: z.string().describe("res:// path to the chosen exploration image"),
    game_description: z.string().describe("Game description for context"),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory
    let absPath = params.chosen_path
    if (absPath.startsWith("res://")) {
      absPath = path.join(projectRoot, absPath.slice(6))
    }

    try {
      const imgData = await fs.readFile(absPath)
      const base64 = imgData.toString("base64")
      const dataUrl = `data:image/png;base64,${base64}`

      return {
        title: `Loaded style reference: ${path.basename(absPath)}`,
        metadata: {
          chosen_path: params.chosen_path,
          game_description: params.game_description,
          image_data: dataUrl,
        },
        output: `Style image loaded: ${params.chosen_path} (${imgData.length} bytes)\n\nGame: ${params.game_description}\n\nPlease analyze this image to extract:\n1. Color palette (provide HEX values for main colors)\n2. Art style description (line weight, shading, pixel density, etc.)\n3. Lighting and shadow rules\n4. Character/object proportions\n\nThen:\n- Write docs/visual_bible.md with these visual rules\n- Call godot_style_set with reference_asset="${params.chosen_path}" and art_direction="[your style description]"\n\nImage data is available in the metadata.image_data field for vision analysis.`,
      }
    } catch (err: any) {
      return {
        title: "Art confirm failed",
        metadata: { error: err.message },
        output: `Error: Could not read image at ${params.chosen_path}: ${err.message}`,
      }
    }
  },
})

// =============================================================================
// godot_style_set - Lock in the project art style profile
// =============================================================================

const STYLE_SET_DESCRIPTION = `Save the project's art style profile to .ai_style_profile.json.

Call this after analyzing the chosen style image (godot_art_confirm). Provide:
- reference_asset: the chosen exploration image (or cornerstone hero after generation)
- art_direction: TECHNIQUE-ONLY style tag (max 30 words). This gets prepended to EVERY future asset prompt.
  GOOD: "16-bit pixel art, dark fantasy palette, 1px black outlines, no anti-aliasing, flat shading"
  BAD: "Dark moody casino atmosphere, deep emerald green felt table, cards have cream-white faces..." (this is CONTENT, not style)
  The art_direction must describe HOW to render (technique, medium, shading, outline style) — NOT WHAT to render (scenes, objects, backgrounds).
- palette: HEX color values extracted from the reference image

After calling this, godot_asset_pipeline will automatically apply this style to all new assets.`

export const GodotStyleSetTool = Tool.define("godot_style_set", {
  description: STYLE_SET_DESCRIPTION,
  parameters: z.object({
    reference_asset: z.string().describe("res:// path to the reference/anchor image for consistency"),
    art_direction: z.string().describe("TECHNIQUE-ONLY style tag, max 30 words. Describes rendering style (medium, shading, outlines), NOT content/scenes. Example: '16-bit pixel art, dark fantasy palette, 1px black outlines, flat 2-tone shading, no anti-aliasing'"),
    palette: z.array(z.string()).optional().describe("HEX color values, e.g. ['#1a1a2e', '#e94560']"),
    consistency_model: z.string().optional().describe("Model for consistency generation (default: flux-2-pro)"),
    consistency_strength: z.number().optional().describe("Reference influence strength 0.0-1.0 (default: 0.7)"),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory

    // Warn if art_direction looks like content instead of technique
    const wordCount = params.art_direction.split(/\s+/).length
    let warning = ""
    if (wordCount > 40) {
      warning = `\n\n⚠️ WARNING: art_direction is ${wordCount} words (recommended: ≤30). It should describe rendering TECHNIQUE only (medium, shading, outlines), not scene content. Long art_direction pollutes every asset prompt. Consider shortening it.`
    }

    const profile: StyleProfile = {
      reference_asset: params.reference_asset,
      art_direction: params.art_direction,
      consistency_model: params.consistency_model ?? getModelDefaults().style_set,
      consistency_strength: params.consistency_strength ?? 0.7,
      palette: params.palette ?? [],
      created_at: new Date().toISOString(),
    }

    await writeProfile(projectRoot, profile)

    return {
      title: "Art style profile saved",
      metadata: { profile },
      output: `Style profile saved to .ai_style_profile.json\n\nStyle: ${profile.art_direction}\nReference: ${params.reference_asset}\nModel: ${profile.consistency_model} (strength: ${profile.consistency_strength})\nPalette: ${profile.palette.join(", ") || "(none)"}\n\nAll future godot_asset_pipeline calls will automatically use this style.${warning}`,
    }
  },
})

// =============================================================================
// godot_asset_review - AI visual review: compare generated asset to reference
// =============================================================================

const ASSET_REVIEW_DESCRIPTION = `Review a generated asset for style consistency against a reference image.

Returns structured scores and recommendations. Use after generating each cornerstone asset or when the user wants quality verification.

Reads both images and returns base64 data for your vision analysis. You should evaluate:
- Style consistency (does it match the reference art style?)
- Visual clarity (is the asset readable at game resolution?)
- Visual Bible compliance (does it follow the established rules?)

Then present findings to the user and ask: Pass / Regenerate / Adjust prompt.`

export const GodotAssetReviewTool = Tool.define("godot_asset_review", {
  description: ASSET_REVIEW_DESCRIPTION,
  parameters: z.object({
    asset_path: z.string().describe("res:// path to the asset to review"),
    reference_path: z.string().describe("res:// path to the reference image (exploration or cornerstone hero)"),
    asset_role: z.string().describe("What this asset represents, e.g. 'hero character', 'ground tile', 'UI panel'"),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory

    const toAbs = (p: string) => p.startsWith("res://") ? path.join(projectRoot, p.slice(6)) : p

    let assetData: string | null = null
    let refData: string | null = null

    try {
      const assetBuf = await fs.readFile(toAbs(params.asset_path))
      assetData = `data:image/png;base64,${assetBuf.toString("base64")}`
    } catch (err: any) {
      return {
        title: "Review failed",
        metadata: { error: "asset_not_found" },
        output: `Error: Cannot read asset at ${params.asset_path}: ${err.message}`,
      }
    }

    try {
      const refBuf = await fs.readFile(toAbs(params.reference_path))
      refData = `data:image/png;base64,${refBuf.toString("base64")}`
    } catch {
      refData = null
    }

    return {
      title: `Ready to review: ${path.basename(toAbs(params.asset_path))}`,
      metadata: {
        asset_path: params.asset_path,
        reference_path: params.reference_path,
        asset_role: params.asset_role,
        asset_image: assetData,
        reference_image: refData,
      },
      output: `Asset review requested for: ${params.asset_path}\nRole: ${params.asset_role}\nReference: ${params.reference_path}\n\nPlease compare the two images (available in metadata.asset_image and metadata.reference_image) and provide:\n\n**Style Consistency**: X/5 — [explanation]\n**Visual Clarity**: X/5 — [explanation]\n**Visual Bible Compliance**: X/5 — [explanation]\n**Overall**: Pass / Needs Revision\n**Suggestions**: [if any]\n\nThen ask the user:\n- ✅ Pass — continue to next asset\n- 🔄 Regenerate with same prompt\n- ✏️ Adjust prompt (ask user for changes)`,
    }
  },
})

// =============================================================================
// godot_cornerstone_generate - Generate baseline asset suite sequentially
// =============================================================================

const CORNERSTONE_DESCRIPTION = `Generate a STYLE REFERENCE image to establish the project's visual foundation. Do NOT use for actual game assets.

This tool is ONLY for the early style exploration phase — before any real assets are produced.
Output goes to res://assets/cornerstone/ — these images are reference material, NOT game-ready assets.

WHEN TO USE: User says "set up art style", "create style reference", "establish visual direction", or during worldbuilding.
WHEN NOT TO USE: User says "generate atlas", "create sprite", "make texture", "generate UI" — use godot_asset_pipeline instead.

Workflow:
1. Generate first cornerstone without reference_image (pure text2img — establishes the look)
2. After approval: call godot_style_set to set reference_asset to that path
3. Generate remaining cornerstones with reference for consistency

Call this tool ONCE per image. Score the result and retry if needed.`

export const GodotCornerstoneGenerateTool = Tool.define("godot_cornerstone_generate", {
  description: CORNERSTONE_DESCRIPTION,
  parameters: z.object({
    subject: z.string().describe("What to generate, e.g. 'hero knight idle pose', 'skeleton enemy', 'stone ground tile', 'health bar frame'"),
    asset_type: z.enum(["character", "enemy", "environment", "ui", "item", "effect"]).describe("Category of the asset"),
    aspect_ratio: z.string().default("16:9").describe("Image aspect ratio — choose based on game orientation and asset type. E.g. '16:9' for landscape UI/environments, '9:16' for portrait/mobile games, '1:1' for icons/items, '3:4' for character portraits"),
    filename: z.string().describe("Output filename without extension, e.g. 'hero_idle', 'ui_mockup', 'main_menu_layout'"),
    art_direction: z.string().optional().describe("Style description override (reads from .ai_style_profile.json if not provided)"),
    model: z.string().optional().describe("Image generation model override (default: from project config)"),
    reference_image: z.string().optional().describe("Reference image path (res:// or absolute) for style consistency. If not provided, reads from style profile. Omit to generate without reference."),
    attempt: z.number().int().min(1).default(1).describe("Current attempt number (increment on retry)"),
    max_retries: z.number().int().min(1).max(5).default(3).describe("Maximum total attempts"),
    previous_feedback: z.string().optional().describe("Feedback from previous attempt to refine the prompt"),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory
    const profile = readProfile(projectRoot)
    const artDirection = params.art_direction ?? profile?.art_direction ?? ""

    if (!artDirection) {
      return {
        title: "Cornerstone generation failed",
        metadata: { error: "no_art_direction" } as Record<string, any>,
        output: "Error: No art direction found. Please run godot_art_explore → godot_art_confirm → godot_style_set first, or provide art_direction parameter.",
      }
    }

    const slug = params.filename
    const resPath = `res://assets/cornerstone/${slug}.png`
    const refPath = params.reference_image ?? profile?.reference_asset

    // Validate reference image exists if provided
    if (refPath) {
      const refAbsPath = refPath.startsWith("res://")
        ? path.join(projectRoot, refPath.slice(6))
        : path.join(projectRoot, refPath)
      try {
        await fs.access(refAbsPath)
      } catch {
        return {
          title: "Cornerstone: reference image not found",
          metadata: { error: "reference_not_found", reference: refPath } as Record<string, any>,
          output: `The reference image "${refPath}" does not exist on disk.\n\nPlease ask the user which reference image to use, or omit reference_image to generate without style reference.`,
        }
      }
    }

    // Delegate to asset pipeline (no post-processing for cornerstones)
    const pipeline = await GodotAssetPipelineTool.init()
    const result = await pipeline.execute({
      prompt: `${params.subject}, ${params.aspect_ratio} composition`,
      destination: resPath,
      asset_type: "texture",
      requirements: { match_size: false, min_score: 7 },
      model: params.model ?? getModelDefaults().cornerstone,
      reference_image: refPath,
      use_project_style: true,
      attempt: params.attempt,
      max_retries: params.max_retries,
      previous_feedback: params.previous_feedback,
      usage: {
        role: `${params.asset_type} cornerstone (${params.aspect_ratio})`,
        transparent_bg: false,
        tiling: "none" as const,
      },
    }, ctx)

    // Re-wrap with cornerstone-specific output
    const pipelineMeta = result.metadata as Record<string, any>
    if (pipelineMeta.error) {
      return result
    }

    ctx.metadata({ title: `Cornerstone: ${params.subject} generated ✓` })

    return {
      ...result,
      title: `Cornerstone: ${slug} (attempt ${params.attempt}/${params.max_retries})`,
      metadata: {
        ...pipelineMeta,
        asset_type: params.asset_type,
        has_reference: !!refPath,
      },
      output: `Cornerstone asset generated (attempt ${params.attempt}/${params.max_retries}).

Destination: ${resPath}
Subject: "${params.subject}"
Category: ${params.asset_type}
${refPath ? `Reference: ${refPath}` : "No reference image — this asset establishes the visual style"}

SCORE the result 1-10:
  - Style Consistency (3x) — does it match the project art style?
  - Subject Accuracy (2x) — does it depict "${params.subject}"?
  - Visual Clarity (2x) — clean, readable, game-ready?
  - Category Fit (1x) — suitable as a ${params.asset_type} asset?

DECIDE:
  - Score >= 7: Reply "PASS — Score: X/10" and confirm at ${resPath}${!refPath ? "\n    Then call godot_style_set to set reference_asset to this path for subsequent assets." : ""}
  - Score < 7 AND attempt < ${params.max_retries}: Call godot_cornerstone_generate again with attempt=${params.attempt + 1}, previous_feedback="[your suggestions]"
  - Score < 7 AND attempt >= ${params.max_retries}: Reply "FAIL — Score: X/10 — max retries reached"`,
    }
  },
})

// =============================================================================
// Helper: Generate placeholder content
// =============================================================================

function generatePlaceholderContent(
  type: AssetProvider.AssetType,
  category: string,
  width?: number,
  height?: number,
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
      const w = width ?? 64
      const h = height ?? 64
      return { content: generateSolidPNG(w, h, color), extension: ".png" }
    }

    case "model":
    case "mesh":
    case "scene": {
      // GLB placeholder — matches the format Meshy generates,
      // so no extension mismatch when replacing placeholder with real asset.
      return { content: generateBoxGLB(color), extension: ".glb" }
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

/**
 * Generate a minimal valid GLB (glTF Binary) file containing a colored unit box.
 *
 * Layout: 24 vertices (4 per face with normals), 36 indices, PBR material
 * with the given base color. Godot imports this natively as a PackedScene.
 */
function generateBoxGLB(color: [number, number, number, number]): Buffer {
  // ── Mesh data ──────────────────────────────────────────────────────────
  // Unit box: 6 faces × 4 vertices = 24 vertices, 6 faces × 2 triangles × 3 = 36 indices
  const positions = new Float32Array([
    // +X face
    0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5,
    // -X face
    -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5, -0.5, -0.5,
    // +Y face
    -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5,
    // -Y face
    -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5,
    // +Z face
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    // -Z face
    0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5,
  ])

  const normals = new Float32Array([
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
  ])

  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
    8, 9, 10, 8, 10, 11,
    12, 13, 14, 12, 14, 15,
    16, 17, 18, 16, 18, 19,
    20, 21, 22, 20, 22, 23,
  ])

  const posBuf = Buffer.from(positions.buffer)
  const normBuf = Buffer.from(normals.buffer)
  const idxBuf = Buffer.from(indices.buffer)

  // Pad each buffer to 4-byte alignment
  const pad = (n: number) => (4 - (n % 4)) % 4
  const binBody = Buffer.concat([
    posBuf, Buffer.alloc(pad(posBuf.length)),
    normBuf, Buffer.alloc(pad(normBuf.length)),
    idxBuf, Buffer.alloc(pad(idxBuf.length)),
  ])

  const posOff = 0
  const posLen = posBuf.length
  const normOff = posLen + pad(posLen)
  const normLen = normBuf.length
  const idxOff = normOff + normLen + pad(normLen)
  const idxLen = idxBuf.length

  // ── glTF JSON ──────────────────────────────────────────────────────────
  const baseColor = [color[0] / 255, color[1] / 255, color[2] / 255, color[3] / 255]

  const gltf = {
    asset: { version: "2.0", generator: "makabaka-engine" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Placeholder" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: baseColor,
        metallicFactor: 0,
        roughnessFactor: 0.8,
      },
      name: "placeholder",
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", max: [0.5, 0.5, 0.5], min: [-0.5, -0.5, -0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: posOff, byteLength: posLen, target: 34962 },
      { buffer: 0, byteOffset: normOff, byteLength: normLen, target: 34962 },
      { buffer: 0, byteOffset: idxOff, byteLength: idxLen, target: 34963 },
    ],
    buffers: [{ byteLength: binBody.length }],
  }

  // JSON chunk (pad to 4-byte with spaces)
  let jsonStr = JSON.stringify(gltf)
  while (jsonStr.length % 4 !== 0) jsonStr += " "
  const jsonBuf = Buffer.from(jsonStr, "utf8")

  // ── GLB assembly ───────────────────────────────────────────────────────
  const headerLen = 12
  const jsonChunkLen = 8 + jsonBuf.length
  const binChunkLen = 8 + binBody.length
  const totalLen = headerLen + jsonChunkLen + binChunkLen

  const out = Buffer.alloc(totalLen)
  let off = 0

  // Header: magic, version, length
  out.writeUInt32LE(0x46546c67, off); off += 4 // "glTF"
  out.writeUInt32LE(2, off); off += 4           // version
  out.writeUInt32LE(totalLen, off); off += 4    // total length

  // JSON chunk
  out.writeUInt32LE(jsonBuf.length, off); off += 4
  out.writeUInt32LE(0x4e4f534a, off); off += 4 // "JSON"
  jsonBuf.copy(out, off); off += jsonBuf.length

  // BIN chunk
  out.writeUInt32LE(binBody.length, off); off += 4
  out.writeUInt32LE(0x004e4942, off); off += 4 // "BIN\0"
  binBody.copy(out, off)

  return out
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
