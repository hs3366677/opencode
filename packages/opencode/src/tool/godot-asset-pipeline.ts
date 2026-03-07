import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { AssetMetadata } from "../provider/asset/metadata"
import type { AssetProvider } from "../provider/asset/asset-provider"
import { generateImage } from "../provider/asset/generate-image"
import { readProfile } from "../provider/asset/style-profile"
import { Identifier } from "../id/id"
import type { MessageV2 } from "../session/message-v2"
import { getModelDefaults } from "../config/model-defaults"

// =============================================================================
// Helpers
// =============================================================================

function resolveResPath(resPath: string): string {
  if (resPath.startsWith("res://")) {
    return path.join(Instance.directory, resPath.slice(6))
  }
  return resPath
}

// =============================================================================
// godot_asset_pipeline — Generate → auto-postprocess → return for scoring
// =============================================================================

const PIPELINE_DESCRIPTION = `PRIMARY tool for generating ALL game assets — sprites, textures, atlases, UI elements, icons, backgrounds, cubemaps. ALWAYS use this tool when the user asks to generate, create, or regenerate any image asset.

Use this for: atlas sheets, sprite sheets, UI panels, buttons, icons, tilesets, character sprites, backgrounds, and any image that goes into the game.
Do NOT use godot_cornerstone_generate for these — that tool is only for early style exploration.

Pipeline: generate via Replicate API → automatic post-processing (remove bg → trim → resize → pad) → save final image → return for your visual scoring.

Post-processing is AUTOMATIC and FIXED — you do NOT need to call godot_asset_remove_bg or godot_asset_postprocess separately.

After the tool returns, you MUST:
1. VISUALLY INSPECT the attached image (first = final processed, second = style reference if present)
2. SCORE the final result x/10
3. PASS (score >= min_score) or RETRY (call this tool again with attempt+1 and previous_feedback)

Max retries controlled by max_retries param.`

export const GodotAssetPipelineTool = Tool.define("godot_asset_pipeline", {
  description: PIPELINE_DESCRIPTION,
  parameters: z.object({
    prompt: z.string().describe("Subject description (style comes from project profile automatically)"),
    destination: z.string().describe("Full res:// path including filename, e.g. 'res://assets/knight/idle.png'"),
    asset_type: z
      .enum(["texture", "sprite", "cubemap"])
      .default("sprite")
      .describe("Asset type for provider resolution"),
    requirements: z
      .object({
        width: z.number().int().positive().optional().describe("Target width in pixels"),
        height: z.number().int().positive().optional().describe("Target height in pixels"),
        transparent_bg: z.boolean().default(true).describe("Remove background and make transparent (default: true for sprites)"),
        min_score: z.number().min(1).max(10).default(7).describe("Minimum score to pass (soft check, x/10)"),
      })
      .default({})
      .describe("Quality requirements — dimensions are enforced via auto post-processing"),
    negative_prompt: z.string().optional().describe("What to avoid in generation"),
    model: z.string().optional().describe("Override model (default: from style profile or project config)"),
    style_reference: z.string().optional().describe("res:// path to override style reference image"),
    use_project_style: z.boolean().default(true).describe("Auto-inject project art direction and reference"),
    attempt: z.number().int().min(1).default(1).describe("Current attempt number (LLM increments on retry)"),
    max_retries: z.number().int().min(1).max(5).default(3).describe("Maximum total attempts"),
    previous_feedback: z
      .string()
      .optional()
      .describe("Your feedback from the previous attempt — used to refine prompt on retry"),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory

    // ── Step 0: Read existing metadata for usage constraints ──────────
    // If the destination already has a placeholder with usage, inherit its constraints.

    const destPath = resolveResPath(params.destination)
    const existingMeta = await AssetMetadata.read(destPath)
    const usage = existingMeta?.usage

    // Auto-fill requirements from usage (explicit params take priority)
    const requirements = {
      width: params.requirements.width ?? usage?.width,
      height: params.requirements.height ?? usage?.height,
      transparent_bg: params.requirements.transparent_bg ?? usage?.transparent_bg ?? true,
      min_score: params.requirements.min_score ?? 7,
    }

    // ── Step 1: Build effective prompt with style profile ──────────────

    let effectivePrompt = params.prompt
    let effectiveModel = params.model ?? getModelDefaults().image_generation
    let effectiveParameters: Record<string, unknown> = {}
    let refImageAbsPath: string | undefined

    if (params.use_project_style !== false) {
      const profile = readProfile(projectRoot)
      if (profile) {
        if (profile.art_direction) {
          effectivePrompt = `${profile.art_direction}. ${effectivePrompt}`
        }
        const refAsset = params.style_reference ?? profile.reference_asset
        if (refAsset) {
          effectiveParameters.input_image = refAsset
          refImageAbsPath = resolveResPath(refAsset)
        }
        if (!effectiveModel && profile.consistency_model) {
          effectiveModel = profile.consistency_model
        }
      }
    }

    // Append aspect ratio hint derived from target dimensions
    if (requirements.width && requirements.height) {
      const w = requirements.width
      const h = requirements.height
      const ratio = w / h
      let compositionHint: string
      if (Math.abs(ratio - 1) < 0.1) {
        compositionHint = "square composition"
      } else if (ratio > 1) {
        compositionHint = `wide landscape ${w}:${h} composition`
      } else {
        compositionHint = `tall portrait ${w}:${h} composition`
      }
      effectivePrompt = `${effectivePrompt}. ${compositionHint}, output ${w}x${h}px`
    }

    // Append previous feedback as refinement context on retry
    if (params.previous_feedback) {
      effectivePrompt = `${effectivePrompt}. [Refinement from previous attempt: ${params.previous_feedback}]`
    }

    // ── Step 2: Generate image ─────────────────────────────────────────

    ctx.metadata({ title: `Pipeline: generating (attempt ${params.attempt}/${params.max_retries})...` })

    const genResult = await generateImage({
      type: params.asset_type as AssetProvider.AssetType,
      prompt: effectivePrompt,
      negativePrompt: params.negative_prompt,
      model: effectiveModel,
      parameters: effectiveParameters,
      destPath,
      abortSignal: ctx.abort,
    })

    if (!genResult.success || !genResult.data) {
      if (genResult.error === "Aborted") {
        return {
          title: "Pipeline cancelled",
          metadata: { generationId: genResult.generationId },
          output: "Pipeline was cancelled by user.",
        }
      }
      return {
        title: "Pipeline: generation failed",
        metadata: { generationId: genResult.generationId, error: genResult.error, attempt: params.attempt },
        output: `Generation failed (attempt ${params.attempt}/${params.max_retries}): ${genResult.error || "Unknown error"}${params.attempt < params.max_retries ? "\nYou may retry with adjusted prompt." : ""}`,
      }
    }

    const provider = { id: genResult.provider }
    const modelId = genResult.model
    let imageBuffer = genResult.data
    const sharp = (await import("sharp")).default
    const rawMeta = await sharp(imageBuffer).metadata()
    const postProcessingLog: string[] = []

    // ── Step 3: Fixed post-processing pipeline ──────────────────────────

    ctx.metadata({ title: `Pipeline: post-processing (attempt ${params.attempt}/${params.max_retries})...` })

    // 3a. Remove background → transparent
    if (requirements.transparent_bg) {
      const { removeBackground } = await import("@imgly/background-removal-node")
      const inputBlob = new Blob([imageBuffer], { type: "image/png" })
      const resultBlob = await removeBackground(inputBlob, { model: "small" })
      imageBuffer = Buffer.from(await resultBlob.arrayBuffer())
      postProcessingLog.push("remove_bg(small)")
    }

    // 3b. Trim to non-transparent pixels (only if we have transparency)
    if (requirements.transparent_bg) {
      const trimmed = await sharp(imageBuffer)
        .trim({ threshold: 10 })
        .toBuffer()
      imageBuffer = trimmed
      postProcessingLog.push("trim(threshold=10)")
    }

    // 3c. Resize to fit within target dimensions (keep aspect ratio)
    const targetW = requirements.width
    const targetH = requirements.height
    if (targetW || targetH) {
      imageBuffer = await sharp(imageBuffer)
        .resize(targetW ?? null, targetH ?? null, {
          fit: "inside",
          withoutEnlargement: false,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer()
      postProcessingLog.push(`resize(${targetW ?? "auto"}x${targetH ?? "auto"}, inside)`)
    }

    // 3d. Pad to exact target dimensions with transparent pixels
    if (targetW && targetH) {
      const currentMeta = await sharp(imageBuffer).metadata()
      const cw = currentMeta.width ?? targetW
      const ch = currentMeta.height ?? targetH
      const padLeft = Math.floor((targetW - cw) / 2)
      const padTop = Math.floor((targetH - ch) / 2)
      const padRight = targetW - cw - padLeft
      const padBottom = targetH - ch - padTop

      if (padLeft > 0 || padTop > 0 || padRight > 0 || padBottom > 0) {
        imageBuffer = await sharp(imageBuffer)
          .extend({
            top: Math.max(0, padTop),
            bottom: Math.max(0, padBottom),
            left: Math.max(0, padLeft),
            right: Math.max(0, padRight),
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer()
        postProcessingLog.push(`pad(${padTop},${padRight},${padBottom},${padLeft})`)
      }
    }

    // ── Step 4: Save final image ────────────────────────────────────────

    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.writeFile(destPath, imageBuffer)

    const relPath = path.relative(projectRoot, destPath)
    const resPath = `res://${relPath.replace(/\\/g, "/")}`

    const finalMeta = await sharp(imageBuffer).metadata()

    // Write metadata (preserve usage from placeholder if present)
    const assetMetadata: AssetProvider.AssetMetadata = {
      origin: "generated",
      asset_type: params.asset_type as AssetProvider.AssetType,
      prompt: effectivePrompt,
      negative_prompt: params.negative_prompt,
      provider: provider.id,
      model: modelId,
      generation_id: genResult.generationId,
      parameters: effectiveParameters,
      usage,
      created_at: new Date().toISOString(),
      version: params.attempt,
      post_processing: postProcessingLog.map((op) => ({
        operation: op,
        timestamp: new Date().toISOString(),
      })),
    }
    await AssetMetadata.write(destPath, assetMetadata)

    // ── Step 5: Build attachments for LLM vision ──────────────────────

    const attachments: MessageV2.FilePart[] = [
      {
        id: Identifier.ascending("part"),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        type: "file" as const,
        mime: "image/png",
        url: `data:image/png;base64,${imageBuffer.toString("base64")}`,
      },
    ]

    // Attach reference image for side-by-side comparison
    if (refImageAbsPath) {
      try {
        const refBuf = await fs.readFile(refImageAbsPath)
        attachments.push({
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file" as const,
          mime: "image/png",
          url: `data:image/png;base64,${refBuf.toString("base64")}`,
        })
      } catch {
        // reference image not available, skip
      }
    }

    // ── Step 6: Build output with scoring instructions ──────────────────

    const usageInfo = usage
      ? `\nUsage: ${usage.role}${usage.width && usage.height ? ` (${usage.width}x${usage.height})` : ""}${usage.transparent_bg ? ", transparent" : ""}${usage.tiling && usage.tiling !== "none" ? `, tiling: ${usage.tiling}` : ""}${usage.scene ? `, scene: ${usage.scene}` : ""}`
      : ""

    const output = `Asset generated and post-processed (attempt ${params.attempt}/${params.max_retries}).

Destination: ${resPath}
Raw dimensions: ${rawMeta.width}x${rawMeta.height}
Final dimensions: ${finalMeta.width}x${finalMeta.height}
Post-processing: ${postProcessingLog.length > 0 ? postProcessingLog.join(" → ") : "none"}
Prompt: "${params.prompt}"${usageInfo}

The image has been automatically post-processed. DO NOT call godot_asset_remove_bg or godot_asset_postprocess.

SCORE the final result (first attachment) on a scale of 1-10:
  - Style Consistency (3x weight) — does it match the reference art style?
  - Subject Accuracy (2x weight) — does it depict "${params.prompt}"?
  - Visual Clarity (2x weight) — is it clean, readable, game-ready?${usage ? `\n  - Usage Fit (2x weight) — is it suitable as "${usage.role}"?` : ""}
  - Palette Compliance (1x weight) — does it follow the project palette?

DECIDE:
  - Score >= ${requirements.min_score}: Reply "PASS — Score: X/10" and confirm the asset at ${resPath}
  - Score < ${requirements.min_score} AND attempt < ${params.max_retries}: Call godot_asset_pipeline again with attempt=${params.attempt + 1}, previous_feedback="[your specific suggestions]"
  - Score < ${requirements.min_score} AND attempt >= ${params.max_retries}: Reply "FAIL — Score: X/10 — max retries reached" and ask the user what to do`

    return {
      title: `Pipeline: attempt ${params.attempt}/${params.max_retries}`,
      metadata: {
        attempt: params.attempt,
        max_retries: params.max_retries,
        destination: resPath,
        raw_dimensions: `${rawMeta.width}x${rawMeta.height}`,
        final_dimensions: `${finalMeta.width}x${finalMeta.height}`,
        post_processing: postProcessingLog,
        format: finalMeta.format,
        generation_id: genResult.generationId,
        provider: provider.id,
        model: modelId,
      },
      output,
      attachments,
    }
  },
}, { agents: ["asset-generator"] })
