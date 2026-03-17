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
import { Auth } from "../auth"
import { getRemoveBgMethod, getImageModel } from "../server/routes/ai-assets"

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

IMPORTANT — Iterating on existing assets:
When the user asks to IMPROVE, OPTIMIZE, or REGENERATE an existing asset, you MUST pass the current asset's res:// path as reference_image. This sends the existing image to the generation model as an image-to-image reference, producing a refined version instead of generating from scratch.

After the tool returns, you MUST:
1. VISUALLY INSPECT the attached image (first = final processed, second = style reference if present, third = reference image if provided)
2. SCORE the final result x/10
3. PASS (score >= min_score) or RETRY (call this tool again with attempt+1, previous_feedback, AND reference_image pointing to the latest version)

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
        crop: z.boolean().optional().describe("Crop to non-transparent pixels after bg removal. Defaults to true when transparent_bg is true, false otherwise."),
        match_size: z.boolean().default(true).describe("Resize and pad to match usage width/height exactly"),
        min_score: z.number().min(1).max(10).default(7).describe("Minimum score to pass (soft check, x/10)"),
      })
      .default({ match_size: true, min_score: 7 })
      .describe("Pipeline control flags"),
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
    reference_image: z
      .string()
      .optional()
      .describe("res:// path to an existing asset to use as image-to-image reference. MUST be provided when improving/optimizing an existing asset."),
    prompt_strength: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("How much to deviate from reference_image. 0 = almost identical, 1 = ignore reference. Only used with reference_image."),
    usage: z
      .object({
        role: z.string(),
        transparent_bg: z.boolean().optional(),
        tiling: z.enum(["none", "horizontal", "vertical", "both"]).optional(),
        scene: z.string().optional(),
        node_path: z.string().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      })
      .optional()
      .describe("Usage metadata to attach to the asset (overrides placeholder usage)"),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory

    // ── Step 0: Read existing metadata for usage constraints ──────────
    // If the destination already has a placeholder with usage, inherit its constraints.

    const destPath = resolveResPath(params.destination)
    const existingMeta = await AssetMetadata.read(destPath)
    const usage = params.usage ?? existingMeta?.usage

    // Derive post-processing settings from usage
    const transparent_bg = usage?.transparent_bg ?? true
    const targetW = usage?.width
    const targetH = usage?.height
    const shouldCrop = params.requirements.crop ?? transparent_bg
    const matchSize = params.requirements.match_size ?? true
    const minScore = params.requirements.min_score ?? 7

    // ── Step 1: Build generation prompt and effective prompt ────────────
    //
    // generationPrompt = user intent (prompt + retry feedback) — saved to metadata
    // effectivePrompt  = generationPrompt + runtime context (art_direction, aspect hints) — sent to API only

    let generationPrompt = params.prompt
    if (params.previous_feedback) {
      generationPrompt = `${generationPrompt}. [Refinement: ${params.previous_feedback}]`
    }

    let effectivePrompt = generationPrompt
    let effectiveModel = params.model ?? await getImageModel()
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

    // Override with explicit reference_image (img2img for iterative refinement)
    if (params.reference_image) {
      effectiveParameters.input_image = params.reference_image
      refImageAbsPath = resolveResPath(params.reference_image)
      if (params.prompt_strength !== undefined) {
        effectiveParameters.prompt_strength = params.prompt_strength
      }
    }

    // Append background transparency hint to guide generation
    if (transparent_bg) {
      effectivePrompt = `${effectivePrompt}. isolated subject on plain solid-color background, no complex background`
    } else {
      effectivePrompt = `${effectivePrompt}. include full background scene`
    }

    // Append aspect ratio hint derived from target dimensions (runtime context only)
    if (targetW && targetH) {
      const w = targetW
      const h = targetH
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

    // ── Step 2: Generate image ─────────────────────────────────────────

    // Pass target dimensions to provider so it can compute correct aspect_ratio
    if (targetW) effectiveParameters.width = targetW
    if (targetH) effectiveParameters.height = targetH

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
    // Method is determined by user config: "replicate" uses Replicate bria/rmbg-2.0, "local" uses RMBG-2.0 sidecar
    if (transparent_bg) {
      const removeBgMethod = await getRemoveBgMethod()
      const replicateAuth = await Auth.get("replicate")
      const replicateKey = replicateAuth?.type === "api" ? replicateAuth.key : undefined

      if (removeBgMethod === "replicate" && replicateKey) {
        // Replicate bria/remove-background (cloud)
        try {
          const Replicate = (await import("replicate")).default
          const client = new Replicate({ auth: replicateKey })
          const dataUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`
          const output = await client.run("bria-ai/rmbg-2.0", { input: { image: dataUrl } })
          let outputUrl: string
          if (typeof output === "string") {
            outputUrl = output
          } else if (output && typeof output === "object" && "url" in (output as any)) {
            outputUrl = String((output as any).url())
          } else {
            outputUrl = String(output)
          }
          const dlResponse = await fetch(outputUrl)
          if (!dlResponse.ok) {
            throw new Error(`Failed to download result from Replicate (${dlResponse.status})`)
          }
          imageBuffer = Buffer.from(await dlResponse.arrayBuffer())
          postProcessingLog.push(shouldCrop ? "remove_bg+crop(replicate)" : "remove_bg(replicate)")
        } catch (e: any) {
          console.warn(`[pipeline] Replicate background removal failed, trying local: ${e?.message ?? e}`)
          // Fall back to local RMBG
          try {
            const rmbgResponse = await fetch("http://127.0.0.1:4096/ai-assets/remove-background", {
              method: "POST",
              headers: { "Content-Type": "image/png" },
              body: new Uint8Array(imageBuffer),
              signal: AbortSignal.timeout(120_000),
            })
            if (!rmbgResponse.ok) {
              throw new Error(`RMBG service returned ${rmbgResponse.status}`)
            }
            imageBuffer = Buffer.from(await rmbgResponse.arrayBuffer())
            postProcessingLog.push("remove_bg(rmbg-2.0-fallback)")
          } catch (e2: any) {
            console.warn(`[pipeline] Background removal skipped: ${e2?.message ?? e2}`)
            postProcessingLog.push("remove_bg(skipped)")
          }
        }
      } else {
        // Local RMBG-2.0 sidecar (default, or fallback when no Replicate key)
        try {
          const rmbgResponse = await fetch("http://127.0.0.1:4096/ai-assets/remove-background", {
            method: "POST",
            headers: { "Content-Type": "image/png" },
            body: new Uint8Array(imageBuffer),
            signal: AbortSignal.timeout(120_000),
          })
          if (!rmbgResponse.ok) {
            throw new Error(`RMBG service returned ${rmbgResponse.status}`)
          }
          imageBuffer = Buffer.from(await rmbgResponse.arrayBuffer())
          postProcessingLog.push("remove_bg(rmbg-2.0)")
        } catch (e: any) {
          console.warn(`[pipeline] Background removal skipped: ${e?.message ?? e}`)
          postProcessingLog.push("remove_bg(skipped)")
        }
      }
    }

    // 3b. Trim transparent pixels
    {
      const trimmed = sharp(imageBuffer).trim()
      const trimInfo = await trimmed.toBuffer({ resolveWithObject: true })
      imageBuffer = trimInfo.data
      postProcessingLog.push("trim")
    }

    // 3c. Resize to fit within target dimensions (keep aspect ratio)
    if ((targetW || targetH) && matchSize) {
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
    if (targetW && targetH && matchSize) {
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

    // ── Step 4: Save final image + raw for debugging ───────────────────

    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.writeFile(destPath, imageBuffer)

    // Save both raw (from AI model) and processed (final) into version dir
    // Determine next version number from existing history (not from attempt)
    const verIndex0 = (await AssetMetadata.readVersionIndex(destPath)) ?? {}
    const rawHistory0: any[] = verIndex0.history ?? []
    const maxExisting = rawHistory0.reduce((max: number, h: any) => {
      const v = typeof h === "number" ? h : (typeof h === "object" && h?.version ? h.version : 0)
      return Math.max(max, v)
    }, 0)
    const version = maxExisting + 1
    const verDir = AssetMetadata.getVersionDir(destPath)
    await fs.mkdir(verDir, { recursive: true })
    const ext = path.extname(destPath)
    // Raw = direct output from AI model (before any post-processing)
    await fs.writeFile(path.join(verDir, `v${version}_raw${ext}`), genResult.data)
    // Processed = after remove_bg + trim + resize + pad
    await fs.writeFile(path.join(verDir, `v${version}${ext}`), imageBuffer)

    const relPath = path.relative(projectRoot, destPath)
    const resPath = `res://${relPath.replace(/\\/g, "/")}`

    const finalMeta = await sharp(imageBuffer).metadata()

    // Write metadata (preserve usage from placeholder if present)
    const assetMetadata: AssetProvider.AssetMetadata = {
      origin: "generated",
      asset_type: params.asset_type as AssetProvider.AssetType,
      prompt: generationPrompt,
      negative_prompt: params.negative_prompt,
      provider: provider.id,
      model: modelId,
      generation_id: genResult.generationId,
      parameters: effectiveParameters,
      usage,
      created_at: new Date().toISOString(),
      version,
      post_processing: postProcessingLog.map((op) => ({
        operation: op,
        timestamp: new Date().toISOString(),
      })),
    }
    await AssetMetadata.write(destPath, assetMetadata)

    // Save per-version metadata (vN.json) for history
    const verMeta = {
      version,
      origin: "generated",
      prompt: generationPrompt,
      negative_prompt: params.negative_prompt ?? "",
      provider: provider.id,
      model: modelId ?? "",
      seed: -1,
      parameters: effectiveParameters,
      generated_at: new Date().toISOString(),
      raw_dimensions: `${rawMeta.width}x${rawMeta.height}`,
      final_dimensions: `${finalMeta.width}x${finalMeta.height}`,
      post_processing: postProcessingLog,
      has_raw: true,
    }
    await fs.writeFile(
      path.join(verDir, `v${version}.json`),
      JSON.stringify(verMeta, null, 2),
      "utf-8",
    )

    // Update version index (metadata.json) with history tracking
    const verIndex = (await AssetMetadata.readVersionIndex(destPath)) ?? {}
    verIndex.current_version = version
    // Normalize history to integer array (old cornerstone wrote object arrays)
    const rawHistory: any[] = verIndex.history ?? []
    const history: number[] = rawHistory
      .map((h: any) => typeof h === "number" ? h : (typeof h === "object" && h?.version ? h.version : null))
      .filter((v: any): v is number => typeof v === "number" && v > 0)
    if (!history.includes(version)) {
      history.push(version)
    }
    verIndex.history = history
    await AssetMetadata.writeVersionIndex(destPath, { ...assetMetadata, ...verIndex })

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
  - Score >= ${minScore}: Reply "PASS — Score: X/10" and confirm the asset at ${resPath}
  - Score < ${minScore} AND attempt < ${params.max_retries}: Call godot_asset_pipeline again with attempt=${params.attempt + 1}, previous_feedback="[your specific suggestions]"
  - Score < ${minScore} AND attempt >= ${params.max_retries}: Reply "FAIL — Score: X/10 — max retries reached" and ask the user what to do`

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
