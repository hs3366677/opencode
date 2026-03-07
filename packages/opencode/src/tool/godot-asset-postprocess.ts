import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { AssetMetadata } from "../provider/asset/metadata"

// =============================================================================
// Helpers
// =============================================================================

function resolveAssetPath(resPath: string): string {
  if (resPath.startsWith("res://")) {
    return path.join(Instance.directory, resPath.slice(6))
  }
  return resPath
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "")
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

// =============================================================================
// godot_asset_postprocess — Pipeline-based image operations (resize, crop, etc.)
// =============================================================================

const OperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resize"),
    width: z.number().int().positive().optional().describe("Target width in pixels"),
    height: z.number().int().positive().optional().describe("Target height in pixels"),
    fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional().describe("How to fit the image (default: contain)"),
    background: z.string().optional().describe("Background color hex for padding (default: transparent)"),
  }),
  z.object({
    type: z.literal("crop"),
    left: z.number().int().min(0).describe("Left offset in pixels"),
    top: z.number().int().min(0).describe("Top offset in pixels"),
    width: z.number().int().positive().describe("Crop width"),
    height: z.number().int().positive().describe("Crop height"),
  }),
  z.object({
    type: z.literal("pad"),
    top: z.number().int().min(0).optional().describe("Top padding in pixels"),
    right: z.number().int().min(0).optional().describe("Right padding in pixels"),
    bottom: z.number().int().min(0).optional().describe("Bottom padding in pixels"),
    left: z.number().int().min(0).optional().describe("Left padding in pixels"),
    color: z.string().optional().describe("Padding color hex (default: transparent)"),
  }),
  z.object({
    type: z.literal("trim"),
    threshold: z.number().int().min(0).max(255).optional().describe("Color similarity threshold (default: 10)"),
  }),
  z.object({
    type: z.literal("format"),
    to: z.enum(["png", "jpeg", "webp"]).describe("Target format"),
    quality: z.number().int().min(1).max(100).optional().describe("Quality for jpeg/webp (default: 80)"),
  }),
])

export const GodotAssetPostprocessTool = Tool.define("godot_asset_postprocess", {
  description: `Post-process an image asset with chained operations (resize, crop, pad, trim, format conversion).
All operations run locally and instantly using the sharp library. Operations are applied in order.

Examples:
- Resize a sprite to 64x64: operations=[{type:"resize", width:64, height:64, fit:"contain"}]
- Crop + resize: operations=[{type:"crop", left:10, top:10, width:200, height:200}, {type:"resize", width:64, height:64}]
- Convert to webp: operations=[{type:"format", to:"webp", quality:90}]
- Trim transparent borders then resize: operations=[{type:"trim"}, {type:"resize", width:128, height:128}]`,
  parameters: z.object({
    asset_path: z.string().describe("res:// path to the image file"),
    operations: z.array(OperationSchema).min(1).describe("Ordered list of operations to apply"),
  }),
  async execute(params) {
    const absPath = resolveAssetPath(params.asset_path)

    // Check file exists
    try {
      await fs.access(absPath)
    } catch {
      return {
        title: "Post-process failed",
        metadata: { error: "file_not_found" },
        output: `Error: File not found: ${params.asset_path}`,
      }
    }

    // Save version before modifying
    await AssetMetadata.saveVersion(absPath)

    // Lazy-load sharp
    const sharp = (await import("sharp")).default

    let pipeline = sharp(absPath)
    const appliedOps: string[] = []

    for (const op of params.operations) {
      switch (op.type) {
        case "resize": {
          const opts: Record<string, unknown> = {
            fit: op.fit ?? "contain",
          }
          if (op.background) {
            const c = parseHexColor(op.background)
            opts.background = { r: c.r, g: c.g, b: c.b, alpha: 1 }
          } else {
            opts.background = { r: 0, g: 0, b: 0, alpha: 0 }
          }
          pipeline = pipeline.resize(op.width ?? null, op.height ?? null, opts)
          appliedOps.push(`resize(${op.width ?? "auto"}x${op.height ?? "auto"}, ${op.fit ?? "contain"})`)
          break
        }
        case "crop": {
          pipeline = pipeline.extract({
            left: op.left,
            top: op.top,
            width: op.width,
            height: op.height,
          })
          appliedOps.push(`crop(${op.left},${op.top} ${op.width}x${op.height})`)
          break
        }
        case "pad": {
          const extend: Record<string, number> = {
            top: op.top ?? 0,
            right: op.right ?? 0,
            bottom: op.bottom ?? 0,
            left: op.left ?? 0,
          }
          const bg = op.color
            ? { ...parseHexColor(op.color), alpha: 1 }
            : { r: 0, g: 0, b: 0, alpha: 0 }
          pipeline = pipeline.extend({ ...extend, background: bg })
          appliedOps.push(`pad(${extend.top},${extend.right},${extend.bottom},${extend.left})`)
          break
        }
        case "trim": {
          pipeline = pipeline.trim({ threshold: op.threshold ?? 10 })
          appliedOps.push(`trim(threshold=${op.threshold ?? 10})`)
          break
        }
        case "format": {
          const quality = op.quality ?? 80
          if (op.to === "png") {
            pipeline = pipeline.png()
          } else if (op.to === "jpeg") {
            pipeline = pipeline.jpeg({ quality })
          } else if (op.to === "webp") {
            pipeline = pipeline.webp({ quality })
          }
          appliedOps.push(`format(${op.to}${op.to !== "png" ? `, q=${quality}` : ""})`)
          break
        }
      }
    }

    // Determine output path (may change extension if format was applied)
    let outputPath = absPath
    const lastFormatOp = [...params.operations].reverse().find((op) => op.type === "format")
    if (lastFormatOp && lastFormatOp.type === "format") {
      const newExt = lastFormatOp.to === "jpeg" ? ".jpg" : `.${lastFormatOp.to}`
      const currentExt = path.extname(absPath)
      if (currentExt.toLowerCase() !== newExt) {
        outputPath = absPath.replace(/\.[^.]+$/, newExt)
      }
    }

    // Write output
    const outputBuffer = await pipeline.toBuffer()
    await fs.writeFile(outputPath, outputBuffer)

    // Get final dimensions
    const meta = await sharp(outputBuffer).metadata()

    // Log to asset metadata
    const existingMeta = await AssetMetadata.read(absPath)
    if (existingMeta) {
      const postProcessing = existingMeta.post_processing ?? []
      postProcessing.push({
        operation: "postprocess",
        params: { operations: appliedOps },
        timestamp: new Date().toISOString(),
      })
      await AssetMetadata.update(absPath, { post_processing: postProcessing } as any)
    }

    const opsDescription = appliedOps.join(" → ")
    return {
      title: "Post-processed",
      metadata: {
        path: params.asset_path,
        output_path: outputPath !== absPath ? outputPath : undefined,
        dimensions: `${meta.width}x${meta.height}`,
        operations: appliedOps,
      },
      output: `Post-processed ${params.asset_path}: ${opsDescription}\nResult: ${meta.width}x${meta.height} ${meta.format}${outputPath !== absPath ? `\nSaved to: ${outputPath}` : ""}`,
    }
  },
})

// =============================================================================
// godot_asset_remove_bg — AI-powered background removal using ONNX model
// =============================================================================

export const GodotAssetRemoveBgTool = Tool.define("godot_asset_remove_bg", {
  description: `Remove the background from an image using a local AI model (ONNX-based, runs entirely on your machine).
Works on any background — complex scenes, gradients, photos — not just solid colors.

The first run downloads the model (~40MB for small, ~80MB for medium). Subsequent runs are instant.

Output is always PNG (to preserve transparency).`,
  parameters: z.object({
    asset_path: z.string().describe("res:// path to the image file"),
    model: z.enum(["small", "medium"]).optional().describe("Model size: small (fast, ~40MB) or medium (better quality, ~80MB). Default: small"),
  }),
  async execute(params) {
    const absPath = resolveAssetPath(params.asset_path)

    // Check file exists
    try {
      await fs.access(absPath)
    } catch {
      return {
        title: "Remove BG failed",
        metadata: { error: "file_not_found" },
        output: `Error: File not found: ${params.asset_path}`,
      }
    }

    // Save version before modifying
    await AssetMetadata.saveVersion(absPath)

    const modelChoice = params.model ?? "small"

    // Lazy-load background removal
    const { removeBackground } = await import("@imgly/background-removal-node")

    // Read the image as a buffer
    const inputBuffer = await fs.readFile(absPath)

    // Create a Blob from the buffer (required by the library)
    const inputBlob = new Blob([inputBuffer], { type: "image/png" })

    // Run background removal
    const resultBlob = await removeBackground(inputBlob, {
      model: modelChoice,
    })

    // Convert result Blob back to Buffer
    const resultArrayBuffer = await resultBlob.arrayBuffer()
    const resultBuffer = Buffer.from(resultArrayBuffer)

    // Ensure output is PNG (for transparency)
    let outputPath = absPath
    const ext = path.extname(absPath).toLowerCase()
    if (ext !== ".png") {
      outputPath = absPath.replace(/\.[^.]+$/, ".png")
    }

    await fs.writeFile(outputPath, resultBuffer)

    // Log to asset metadata
    const existingMeta = await AssetMetadata.read(absPath)
    if (existingMeta) {
      const postProcessing = existingMeta.post_processing ?? []
      postProcessing.push({
        operation: "remove_bg",
        params: { model: modelChoice },
        timestamp: new Date().toISOString(),
      })
      await AssetMetadata.update(absPath, { post_processing: postProcessing } as any)
    }

    // Get output dimensions using sharp
    const sharp = (await import("sharp")).default
    const meta = await sharp(resultBuffer).metadata()

    return {
      title: "Background removed",
      metadata: {
        path: params.asset_path,
        output_path: outputPath !== absPath ? outputPath : undefined,
        dimensions: `${meta.width}x${meta.height}`,
        model: modelChoice,
      },
      output: `Background removed from ${params.asset_path} using ${modelChoice} model.\nResult: ${meta.width}x${meta.height} PNG${outputPath !== absPath ? `\nSaved to: ${outputPath}` : ""}`,
    }
  },
})
