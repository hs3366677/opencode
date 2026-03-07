import { Log } from "../../util/log"
import { AssetProvider } from "./asset-provider"
import { getModelDefaults } from "../../config/model-defaults"

/**
 * Doubao (ByteDance Seedream) provider for 2D image/texture generation.
 *
 * Uses Volcano Engine visual generation API.
 * Supports text-to-image and image editing via Seedream models.
 */
export class DoubaoProvider implements AssetProvider.Provider {
  readonly id = "doubao"
  readonly name = "Doubao (ByteDance)"
  readonly supportedTypes: AssetProvider.AssetType[] = [
    "texture",
    "sprite",
    "cubemap",
    "material",
  ]

  private apiUrl: string
  private apiKey: string
  private log = Log.create({ service: "asset.doubao" })

  constructor(config: { apiKey: string; apiUrl?: string }) {
    this.apiKey = config.apiKey
    this.apiUrl = config.apiUrl ?? "https://visual.volcengineapi.com/v1"
  }

  async listModels(): Promise<AssetProvider.ModelInfo[]> {
    return [
      {
        id: "seedream-4",
        name: "Seedream v4",
        description: "High-quality text-to-image and image editing, up to 4K",
        supportedTypes: ["texture", "sprite", "cubemap", "material"],
        supportedTransforms: ["upscale", "style_transfer", "variation"],
        parameters: [
          {
            name: "width",
            type: "number",
            description: "Image width in pixels",
            default: 1024,
            min: 256,
            max: 4096,
          },
          {
            name: "height",
            type: "number",
            description: "Image height in pixels",
            default: 1024,
            min: 256,
            max: 4096,
          },
          {
            name: "num_images",
            type: "number",
            description: "Number of images to generate",
            default: 1,
            min: 1,
            max: 4,
          },
          {
            name: "style",
            type: "enum",
            description: "Visual style preset",
            default: "auto",
            options: ["auto", "photorealistic", "anime", "pixel_art", "watercolor", "oil_painting"],
          },
        ],
      },
      {
        id: "seedream-3",
        name: "Seedream v3",
        description: "Previous generation model, faster and cheaper",
        supportedTypes: ["texture", "sprite"],
        parameters: [
          {
            name: "width",
            type: "number",
            description: "Image width",
            default: 1024,
            min: 256,
            max: 2048,
          },
          {
            name: "height",
            type: "number",
            description: "Image height",
            default: 1024,
            min: 256,
            max: 2048,
          },
        ],
      },
    ]
  }

  async generate(request: AssetProvider.GenerationRequest): Promise<AssetProvider.GenerationResult> {
    const model = request.model ?? getModelDefaults().image_doubao

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      negative_prompt: request.negativePrompt ?? "",
      width: request.parameters.width ?? 1024,
      height: request.parameters.height ?? 1024,
      n: request.parameters.num_images ?? 1,
    }

    if (request.parameters.style && request.parameters.style !== "auto") {
      body.style = request.parameters.style
    }

    this.log.info("creating image generation task", { model, prompt: request.prompt })

    const response = await this.request("POST", "/images/generations", body)

    // Doubao may return synchronously or async depending on the endpoint
    if (response.data?.[0]?.url) {
      // Synchronous result
      return {
        generationId: response.id || `sync-${Date.now()}`,
        status: "completed",
      }
    }

    return {
      generationId: response.id || response.task_id,
      status: "processing",
    }
  }

  async checkStatus(generationId: string): Promise<AssetProvider.GenerationStatus> {
    // Handle synchronous results
    if (generationId.startsWith("sync-")) {
      return {
        generationId,
        status: "completed",
        progress: 100,
      }
    }

    const task = await this.request("GET", `/images/tasks/${generationId}`)

    const statusMap: Record<string, AssetProvider.GenerationStatus["status"]> = {
      pending: "pending",
      processing: "processing",
      succeeded: "completed",
      failed: "failed",
    }

    return {
      generationId,
      status: statusMap[task.status] ?? "processing",
      progress: task.progress ?? 0,
      message: task.error?.message,
    }
  }

  async download(generationId: string): Promise<AssetProvider.AssetBundle> {
    const task = await this.request("GET", `/images/tasks/${generationId}`)

    if (!task.data?.length) {
      throw new Error(`No images available for task ${generationId}`)
    }

    const assets: AssetProvider.BundleAsset[] = []

    for (let i = 0; i < task.data.length; i++) {
      const image = task.data[i]
      let data: Buffer

      if (image.url) {
        data = await this.downloadFile(image.url)
      } else if (image.b64_json) {
        data = Buffer.from(image.b64_json, "base64")
      } else {
        continue
      }

      assets.push({
        type: "texture",
        role: i === 0 ? "primary" : "texture",
        data,
        filename: `image_${i}.png`,
        metadata: {
          revised_prompt: image.revised_prompt,
          index: i,
        },
      })
    }

    return {
      bundleId: generationId,
      assets,
    }
  }

  supportsTransform(transform: AssetProvider.TransformType): boolean {
    return ["upscale", "style_transfer", "variation"].includes(transform)
  }

  async transform(request: AssetProvider.TransformRequest): Promise<AssetProvider.GenerationResult> {
    const imageBase64 = request.sourceFile.toString("base64")

    let endpoint: string
    const body: Record<string, unknown> = {
      model: request.model ?? getModelDefaults().image_doubao,
      image: imageBase64,
    }

    switch (request.transform) {
      case "upscale":
        endpoint = "/images/upscale"
        body.scale = request.parameters.scale ?? 2
        break
      case "style_transfer":
        endpoint = "/images/edit"
        body.prompt = request.prompt ?? "Apply style transfer"
        body.edit_mode = "style_transfer"
        break
      case "variation":
        endpoint = "/images/variations"
        body.prompt = request.prompt
        body.n = request.parameters.num_images ?? 1
        break
      default:
        throw new Error(`Doubao does not support transform: ${request.transform}`)
    }

    this.log.info("creating transform task", { transform: request.transform })

    const response = await this.request("POST", endpoint, body)

    return {
      generationId: response.id || response.task_id || `sync-${Date.now()}`,
      status: response.data?.[0]?.url ? "completed" : "processing",
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
    const url = `${this.apiUrl}${path}`
    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    }
    if (body) {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)

    if (!response.ok) {
      const text = await response.text()
      this.log.error("doubao api error", { status: response.status, body: text })
      throw new Error(`Doubao API error ${response.status}: ${text}`)
    }

    return response.json()
  }

  private async downloadFile(url: string): Promise<Buffer> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`)
    }
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }
}
