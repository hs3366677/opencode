import Replicate from "replicate"
import fs from "fs/promises"
import path from "path"
import { Log } from "../../util/log"
import { AssetProvider } from "./asset-provider"
import { Instance } from "../../project/instance"

/**
 * Replicate provider for 2D image/texture generation.
 *
 * Uses Replicate's Node.js SDK with built-in progress callbacks and auto-polling.
 * Supports Stable Diffusion 3.5, SDXL, and other open-source image models.
 */
export class ReplicateProvider implements AssetProvider.Provider {
  readonly id = "replicate"
  readonly name = "Replicate"
  readonly supportedTypes: AssetProvider.AssetType[] = [
    "texture",
    "sprite",
    "cubemap",
    "material",
  ]

  private client: Replicate
  private log = Log.create({ service: "asset.replicate" })

  /** In-memory cache of completed prediction outputs keyed by generationId */
  private resultCache = new Map<
    string,
    { status: AssetProvider.GenerationStatus["status"]; output?: string[]; message?: string }
  >()

  /** In-memory cache of downloaded asset bundles to avoid re-fetching from CDN */
  private bundleCache = new Map<string, AssetProvider.AssetBundle>()

  /** Models that use aspect_ratio instead of width/height */
  private static readonly ASPECT_RATIO_MODELS = new Set(["sd-3.5-medium", "sd-3.5-large-turbo", "flux-schnell", "flux-kontext-pro", "flux-kontext-max", "flux-2-dev", "flux-2-pro"])

  /** Models that use cfg instead of guidance_scale */
  private static readonly CFG_MODELS = new Set(["sd-3.5-medium", "sd-3.5-large-turbo"])

  /** Models that do NOT support negative_prompt */
  private static readonly NO_NEGATIVE_PROMPT = new Set(["flux-schnell", "flux-kontext-pro", "flux-kontext-max", "flux-2-dev", "flux-2-pro"])

  /** Models that support img2img via input_image parameter */
  private static readonly KONTEXT_MODELS = new Set(["flux-kontext-pro", "flux-kontext-max"])

  /** FLUX.2 models — use output_quality parameter, quality auto (no go_fast) */
  private static readonly FLUX2_MODELS = new Set(["flux-2-dev", "flux-2-pro"])

  /** Model identifier → Replicate model string mapping */
  private static readonly MODELS: Record<string, {
    ref: `${string}/${string}` | `${string}/${string}:${string}`;
    description: string;
    cost: number;
  }> = {
    "flux-2-dev": {
      ref: "black-forest-labs/flux-2-dev",
      description: "FLUX.2 [dev] — open-source, high quality, output_quality auto",
      cost: 0.012,
    },
    "flux-2-pro": {
      ref: "black-forest-labs/flux-2-pro",
      description: "FLUX.2 [pro] — flagship quality, 6s generation, output_quality auto",
      cost: 0.015,
    },
    "flux-schnell": {
      ref: "black-forest-labs/flux-schnell",
      description: "FLUX.1 Schnell — fastest text-to-image",
      cost: 0.003,
    },
    "flux-kontext-pro": {
      ref: "black-forest-labs/flux-kontext-pro",
      description: "FLUX.1 Kontext [pro] — style consistency via reference image",
      cost: 0.04,
    },
    "flux-kontext-max": {
      ref: "black-forest-labs/flux-kontext-max",
      description: "FLUX.1 Kontext [max] — highest quality style consistency",
      cost: 0.06,
    },
    "sd-3.5-medium": {
      ref: "stability-ai/stable-diffusion-3.5-medium",
      description: "Stable Diffusion 3.5 Medium — balanced quality and speed",
      cost: 0.035,
    },
    "sd-3.5-large-turbo": {
      ref: "stability-ai/stable-diffusion-3.5-large-turbo",
      description: "Stable Diffusion 3.5 Large Turbo — fast, high quality",
      cost: 0.04,
    },
    "sdxl": {
      ref: "stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc",
      description: "Stable Diffusion XL — high-resolution image generation",
      cost: 0.0055,
    },
  }

  constructor(config: { apiKey: string; apiUrl?: string }) {
    this.client = new Replicate({ auth: config.apiKey, useFileOutput: false })
  }

  async listModels(): Promise<AssetProvider.ModelInfo[]> {
    return Object.entries(ReplicateProvider.MODELS).map(([id, model]) => ({
      id,
      name: id,
      description: model.description,
      supportedTypes: ["texture", "sprite", "cubemap", "material"] as AssetProvider.AssetType[],
      supportedTransforms: ["variation"] as AssetProvider.TransformType[],
      pricing: { unit: "per image", cost: model.cost },
      parameters: [
        {
          name: "width",
          type: "number" as const,
          description: "Image width in pixels",
          default: 768,
          min: 64,
          max: 1024,
        },
        {
          name: "height",
          type: "number" as const,
          description: "Image height in pixels",
          default: 768,
          min: 64,
          max: 1024,
        },
        {
          name: "num_outputs",
          type: "number" as const,
          description: "Number of images to generate",
          default: 1,
          min: 1,
          max: 4,
        },
        {
          name: "scheduler",
          type: "enum" as const,
          description: "Diffusion scheduler algorithm",
          default: "DPMSolverMultistep",
          options: ["DDIM", "K_EULER", "DPMSolverMultistep", "K_EULER_ANCESTRAL", "PNDM", "KLMS"],
        },
        {
          name: "num_inference_steps",
          type: "number" as const,
          description: "Number of denoising steps (more = higher quality, slower)",
          default: 50,
          min: 1,
          max: 500,
        },
        {
          name: "guidance_scale",
          type: "number" as const,
          description: "Classifier-free guidance scale (higher = more prompt adherence)",
          default: 7.5,
          min: 1,
          max: 20,
        },
      ],
    }))
  }

  async generate(request: AssetProvider.GenerationRequest): Promise<AssetProvider.GenerationResult> {
    const modelId = request.model ?? "flux-2-dev"
    const modelEntry = ReplicateProvider.MODELS[modelId]

    if (!modelEntry) {
      throw new Error(`Unknown Replicate model: ${modelId}. Available: ${Object.keys(ReplicateProvider.MODELS).join(", ")}`)
    }

    // For FLUX Kontext models: load reference image and prepend consistency prefix
    let effectivePrompt = request.prompt
    let inputImageDataUrl: string | undefined

    if (ReplicateProvider.KONTEXT_MODELS.has(modelId) && request.parameters.input_image) {
      const inputImagePath = String(request.parameters.input_image)
      let absPath = inputImagePath
      if (inputImagePath.startsWith("res://")) {
        absPath = path.join(Instance.directory, inputImagePath.slice(6))
      }
      try {
        const imgData = await fs.readFile(absPath)
        const ext = path.extname(absPath).toLowerCase()
        const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png"
        inputImageDataUrl = `data:${mimeType};base64,${imgData.toString("base64")}`
        effectivePrompt = `Maintain the exact same art style, color palette, and visual quality as the reference. ${request.prompt}`
        this.log.info("kontext img2img: loaded reference image", { path: absPath, size: imgData.length })
      } catch (err: any) {
        this.log.warn("kontext img2img: failed to load reference image", { path: absPath, error: err.message })
      }
    }

    const input: Record<string, unknown> = {
      prompt: effectivePrompt,
    }

    // Set input_image after input object is created
    if (inputImageDataUrl) {
      input.input_image = inputImageDataUrl
    }

    if (request.negativePrompt && !ReplicateProvider.NO_NEGATIVE_PROMPT.has(modelId)) {
      input.negative_prompt = request.negativePrompt
    }
    if (request.parameters.seed) input.seed = request.parameters.seed
    if (request.parameters.num_outputs) input.num_outputs = request.parameters.num_outputs

    if (ReplicateProvider.ASPECT_RATIO_MODELS.has(modelId)) {
      // Aspect-ratio models: convert width/height to closest ratio
      const w = (request.parameters.width as number) || 768
      const h = (request.parameters.height as number) || 768
      input.aspect_ratio = ReplicateProvider.findClosestAspectRatio(w, h, modelId)

      // Parse target size from metadata (e.g., "32x44") for aspect ratio
      if (request.parameters.size) {
        const match = String(request.parameters.size).match(/^(\d+)x(\d+)$/)
        if (match) {
          input.aspect_ratio = ReplicateProvider.findClosestAspectRatio(parseInt(match[1]), parseInt(match[2]), modelId)
        }
      }

      input.output_format = "png"

      // SD 3.5 models use "cfg" instead of "guidance_scale"
      if (ReplicateProvider.CFG_MODELS.has(modelId)) {
        input.cfg = request.parameters.guidance_scale ?? (modelId === "sd-3.5-large-turbo" ? 1 : 5)
      }

      // flux-schnell: num_inference_steps capped at 4
      if (modelId === "flux-schnell") {
        input.num_inference_steps = Math.min(request.parameters.num_inference_steps ?? 4, 4)
      }

      // flux-kontext: output_format png
      if (ReplicateProvider.KONTEXT_MODELS.has(modelId)) {
        input.output_format = "png"
      }

      // FLUX.2: output_quality auto (omit to let model decide, or pass 80 as default)
      if (ReplicateProvider.FLUX2_MODELS.has(modelId)) {
        input.output_format = "png"
        // Do not set output_quality — let the model use its default (auto)
      }
    } else {
      // SDXL and other width/height models
      if (request.parameters.width) input.width = request.parameters.width
      if (request.parameters.height) input.height = request.parameters.height
      if (request.parameters.scheduler) input.scheduler = request.parameters.scheduler
      if (request.parameters.num_inference_steps) input.num_inference_steps = request.parameters.num_inference_steps
      if (request.parameters.guidance_scale) input.guidance_scale = request.parameters.guidance_scale

      // Parse target size from metadata (e.g., "32x44", "96x24") and set API dimensions
      if (request.parameters.size && !input.width && !input.height) {
        const match = String(request.parameters.size).match(/^(\d+)x(\d+)$/)
        if (match) {
          const targetW = parseInt(match[1])
          const targetH = parseInt(match[2])
          // Snap to nearest multiple of 64, clamped to [64, 1024]
          input.width = Math.max(64, Math.min(1024, Math.round(targetW / 64) * 64 || 64))
          input.height = Math.max(64, Math.min(1024, Math.round(targetH / 64) * 64 || 64))
        }
      }
    }

    this.log.info("creating replicate prediction", { model: modelEntry.ref, prompt: request.prompt })

    const generationId = `rep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Track progress
    this.resultCache.set(generationId, { status: "processing" })

    // Run asynchronously with progress callback
    this.runPrediction(generationId, modelEntry.ref, input)

    return {
      generationId,
      status: "processing",
    }
  }

  private async runPrediction(
    generationId: string,
    modelRef: `${string}/${string}` | `${string}/${string}:${string}`,
    input: Record<string, unknown>,
  ): Promise<void> {
    try {
      const output = await this.client.run(modelRef, { input }, (prediction) => {
        this.log.info("replicate progress", {
          id: generationId,
          status: prediction.status,
        })
      })

      // Output is an array of FileOutput objects or URLs
      const urls = this.extractUrls(output)

      this.resultCache.set(generationId, { status: "completed", output: urls })
      this.log.info("replicate prediction completed", { id: generationId, outputCount: urls.length })
    } catch (error: any) {
      this.log.error("replicate prediction failed", { id: generationId, error: error.message })
      this.resultCache.set(generationId, { status: "failed", message: error.message })
    }
  }

  private extractUrls(output: unknown): string[] {
    this.log.info("extractUrls input", { type: typeof output, isArray: Array.isArray(output), value: String(output).slice(0, 200) })
    if (Array.isArray(output)) {
      return output.map((item, i) => {
        if (typeof item === "string") return item
        if (item && typeof item === "object" && "url" in item) {
          const url = typeof (item as any).url === "function" ? String((item as any).url()) : String((item as any).url)
          this.log.info("extractUrls FileOutput", { index: i, url: url.slice(0, 100) })
          return url
        }
        this.log.warn("extractUrls unknown item type", { index: i, type: typeof item, value: String(item).slice(0, 100) })
        return String(item)
      })
    }
    if (typeof output === "string") return [output]
    this.log.warn("extractUrls: empty output", { type: typeof output })
    return []
  }

  async checkStatus(generationId: string): Promise<AssetProvider.GenerationStatus> {
    const cached = this.resultCache.get(generationId)
    if (!cached) {
      return {
        generationId,
        status: "failed",
        message: "Prediction not found",
      }
    }

    return {
      generationId,
      status: cached.status,
      progress: cached.status === "completed" ? 100 : cached.status === "processing" ? 50 : 0,
      ...(cached.message ? { message: cached.message } : {}),
    }
  }

  async download(generationId: string): Promise<AssetProvider.AssetBundle> {
    // Return cached bundle if already downloaded (avoids re-fetching from CDN)
    const cachedBundle = this.bundleCache.get(generationId)
    if (cachedBundle) {
      return cachedBundle
    }

    const cached = this.resultCache.get(generationId)
    if (!cached || !cached.output?.length) {
      throw new Error(`No output available for prediction ${generationId}`)
    }

    const assets: AssetProvider.BundleAsset[] = []

    for (let i = 0; i < cached.output.length; i++) {
      const url = cached.output[i]
      const { data, extension } = await this.downloadFileWithFormat(url)

      assets.push({
        type: "texture",
        role: i === 0 ? "primary" : "texture",
        data,
        filename: `image_${i}${extension}`,
        metadata: {
          source_url: url,
          index: i,
        },
      })
    }

    const bundle: AssetProvider.AssetBundle = {
      bundleId: generationId,
      assets,
    }
    this.bundleCache.set(generationId, bundle)
    return bundle
  }

  supportsTransform(transform: AssetProvider.TransformType): boolean {
    return ["variation"].includes(transform)
  }

  async transform(request: AssetProvider.TransformRequest): Promise<AssetProvider.GenerationResult> {
    if (request.transform !== "variation") {
      throw new Error(`Replicate does not support transform: ${request.transform}`)
    }

    // Use img2img via stable-diffusion with image input
    const input: Record<string, unknown> = {
      prompt: request.prompt ?? "variation of the input image",
      image: `data:image/png;base64,${request.sourceFile.toString("base64")}`,
      prompt_strength: request.parameters.strength ?? 0.6,
    }

    const generationId = `rep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.resultCache.set(generationId, { status: "processing" })
    this.runPrediction(generationId, ReplicateProvider.MODELS["sdxl"].ref, input)

    return {
      generationId,
      status: "processing",
    }
  }

  private async downloadFileWithFormat(url: string): Promise<{ data: Buffer; extension: string }> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download file from Replicate: ${response.status}`)
    }
    const arrayBuffer = await response.arrayBuffer()
    const data = Buffer.from(arrayBuffer)

    // Detect actual format from magic bytes — Replicate often returns WebP despite URL ending in .png
    const extension = this.detectImageExtension(data)
    return { data, extension }
  }

  private detectImageExtension(data: Buffer): string {
    if (data.length < 4) return ".png"
    // PNG: 89 50 4E 47
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return ".png"
    // JPEG: FF D8 FF
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ".jpg"
    // WebP: RIFF....WEBP
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data.length >= 12 &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return ".webp"
    // Default to PNG
    return ".png"
  }

  /** SD 3.5 accepted aspect ratios */
  private static readonly SD35_RATIOS: [string, number][] = [
    ["1:1", 1], ["16:9", 16/9], ["21:9", 21/9], ["3:2", 3/2], ["2:3", 2/3],
    ["4:5", 4/5], ["5:4", 5/4], ["9:16", 9/16], ["9:21", 9/21],
  ]

  /** Flux-schnell accepted aspect ratios (superset with 3:4, 4:3) */
  private static readonly FLUX_RATIOS: [string, number][] = [
    ["1:1", 1], ["16:9", 16/9], ["21:9", 21/9], ["3:2", 3/2], ["2:3", 2/3],
    ["4:5", 4/5], ["5:4", 5/4], ["3:4", 3/4], ["4:3", 4/3], ["9:16", 9/16], ["9:21", 9/21],
  ]

  /** Pick the closest valid aspect ratio from width/height for a given model */
  private static findClosestAspectRatio(w: number, h: number, modelId: string): string {
    const ratios = (modelId === "flux-schnell" || ReplicateProvider.KONTEXT_MODELS.has(modelId) || ReplicateProvider.FLUX2_MODELS.has(modelId))
      ? ReplicateProvider.FLUX_RATIOS
      : ReplicateProvider.SD35_RATIOS
    const target = w / h
    let best = ratios[0][0]
    let bestDiff = Math.abs(target - ratios[0][1])
    for (const [label, ratio] of ratios) {
      const diff = Math.abs(target - ratio)
      if (diff < bestDiff) {
        best = label
        bestDiff = diff
      }
    }
    return best
  }

  /** Quick validation that the API key works */
  async validateApiKey(): Promise<boolean> {
    try {
      // List models is a lightweight call to verify the token
      await this.client.models.list()
      return true
    } catch {
      return false
    }
  }
}
