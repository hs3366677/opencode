import { Log } from "../../util/log"
import { AssetProvider } from "./asset-provider"
import { getModelDefaults } from "../../config/model-defaults"

/**
 * Meshy AI provider for 3D model generation.
 *
 * API docs: https://docs.meshy.ai/en/api/text-to-3d
 * Two-stage workflow: preview (geometry) → refine (textured)
 */
export class MeshyProvider implements AssetProvider.Provider {
  readonly id = "meshy"
  readonly name = "Meshy AI"
  readonly supportedTypes: AssetProvider.AssetType[] = ["model", "mesh", "scene"]

  private apiUrl: string
  private apiKey: string
  private log = Log.create({ service: "asset.meshy" })

  constructor(config: { apiKey: string; apiUrl?: string }) {
    this.apiKey = config.apiKey
    this.apiUrl = config.apiUrl ?? "https://api.meshy.ai/openapi/v2"
  }

  async listModels(): Promise<AssetProvider.ModelInfo[]> {
    return [
      {
        id: "meshy-6",
        name: "Meshy v6",
        description: "Latest model — realistic, production-ready 3D models",
        supportedTypes: ["model", "mesh", "scene"],
        supportedTransforms: ["img2model"],
        parameters: [
          {
            name: "topology",
            type: "enum",
            description: "Mesh topology",
            default: "triangle",
            options: ["triangle", "quad"],
          },
          {
            name: "target_polycount",
            type: "number",
            description: "Target polygon count",
            default: 30000,
            min: 100,
            max: 300000,
          },
          {
            name: "symmetry_mode",
            type: "enum",
            description: "Symmetry enforcement",
            default: "auto",
            options: ["off", "auto", "on"],
          },
          {
            name: "pose_mode",
            type: "enum",
            description: "Character pose mode",
            default: "",
            options: ["", "a-pose", "t-pose"],
          },
        ],
      },
      {
        id: "meshy-5",
        name: "Meshy v5",
        description: "Previous generation model with good quality",
        supportedTypes: ["model", "mesh", "scene"],
        supportedTransforms: ["img2model"],
        parameters: [
          {
            name: "art_style",
            type: "enum",
            description: "Art style",
            default: "realistic",
            options: ["realistic", "sculpture"],
          },
          {
            name: "topology",
            type: "enum",
            description: "Mesh topology",
            default: "triangle",
            options: ["triangle", "quad"],
          },
          {
            name: "target_polycount",
            type: "number",
            description: "Target polygon count",
            default: 30000,
            min: 100,
            max: 300000,
          },
        ],
      },
    ]
  }

  async generate(request: AssetProvider.GenerationRequest): Promise<AssetProvider.GenerationResult> {
    const model = request.model ?? getModelDefaults().model_3d

    // Stage 1: Create preview task (geometry)
    const previewBody: Record<string, unknown> = {
      mode: "preview",
      prompt: request.prompt,
      ai_model: model === "latest" ? "latest" : model,
      topology: request.parameters.topology ?? "triangle",
      target_polycount: request.parameters.target_polycount ?? 30000,
    }

    if (request.parameters.symmetry_mode) {
      previewBody.symmetry_mode = request.parameters.symmetry_mode
    }
    if (request.parameters.pose_mode) {
      previewBody.pose_mode = request.parameters.pose_mode
    }
    if (request.parameters.art_style && model !== "meshy-6") {
      previewBody.art_style = request.parameters.art_style
    }

    this.log.info("creating preview task", { model, prompt: request.prompt })

    const response = await this.request("POST", "/text-to-3d", previewBody)

    return {
      generationId: response.result,
      status: "processing",
    }
  }

  async checkStatus(generationId: string): Promise<AssetProvider.GenerationStatus> {
    const task = await this.request("GET", `/text-to-3d/${generationId}`)

    const statusMap: Record<string, AssetProvider.GenerationStatus["status"]> = {
      PENDING: "pending",
      IN_PROGRESS: "processing",
      SUCCEEDED: "completed",
      FAILED: "failed",
      CANCELED: "failed",
    }

    const status = statusMap[task.status] ?? "pending"

    // If preview succeeded, auto-start refine
    if (task.status === "SUCCEEDED" && task.type === "text-to-3d-preview") {
      this.log.info("preview succeeded, starting refine", { generationId })
      const refineResult = await this.startRefine(generationId, task.prompt)
      return {
        generationId: refineResult.generationId,
        status: "processing",
        progress: 50,
        message: "Preview complete, refining textures...",
      }
    }

    return {
      generationId,
      status,
      progress: task.progress ?? 0,
      message: task.task_error?.message || undefined,
    }
  }

  async download(generationId: string): Promise<AssetProvider.AssetBundle> {
    const task = await this.request("GET", `/text-to-3d/${generationId}`)

    if (task.status !== "SUCCEEDED") {
      throw new Error(`Task ${generationId} is not completed (status: ${task.status})`)
    }

    const assets: AssetProvider.BundleAsset[] = []

    // Download GLB (primary format for Godot)
    if (task.model_urls?.glb) {
      const glbData = await this.downloadFile(task.model_urls.glb)
      assets.push({
        type: "model",
        role: "primary",
        data: glbData,
        filename: "model.glb",
        metadata: { format: "glb" },
      })
    }

    // Download textures if available
    if (task.texture_urls) {
      for (const tex of task.texture_urls) {
        if (tex.base_color) {
          const data = await this.downloadFile(tex.base_color)
          assets.push({
            type: "texture",
            role: "texture",
            data,
            filename: "base_color.png",
            metadata: { map: "base_color" },
          })
        }
        if (tex.metallic) {
          const data = await this.downloadFile(tex.metallic)
          assets.push({
            type: "texture",
            role: "texture",
            data,
            filename: "metallic.png",
            metadata: { map: "metallic" },
          })
        }
        if (tex.normal) {
          const data = await this.downloadFile(tex.normal)
          assets.push({
            type: "texture",
            role: "texture",
            data,
            filename: "normal.png",
            metadata: { map: "normal" },
          })
        }
        if (tex.roughness) {
          const data = await this.downloadFile(tex.roughness)
          assets.push({
            type: "texture",
            role: "texture",
            data,
            filename: "roughness.png",
            metadata: { map: "roughness" },
          })
        }
      }
    }

    return {
      bundleId: generationId,
      assets,
    }
  }

  supportsTransform(transform: AssetProvider.TransformType): boolean {
    return transform === "img2model"
  }

  async transform(request: AssetProvider.TransformRequest): Promise<AssetProvider.GenerationResult> {
    if (request.transform !== "img2model") {
      throw new Error(`Meshy does not support transform: ${request.transform}`)
    }

    const body: Record<string, unknown> = {
      image: request.sourceFile.toString("base64"),
      ai_model: request.model ?? getModelDefaults().model_3d,
    }
    if (request.prompt) {
      body.prompt = request.prompt
    }

    this.log.info("creating image-to-3d task", { transform: request.transform })

    const response = await this.request("POST", "/image-to-3d", body)

    return {
      generationId: response.result,
      status: "processing",
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private async startRefine(
    previewTaskId: string,
    _prompt?: string,
  ): Promise<AssetProvider.GenerationResult> {
    const body: Record<string, unknown> = {
      mode: "refine",
      preview_task_id: previewTaskId,
      enable_pbr: true,
    }

    const response = await this.request("POST", "/text-to-3d", body)

    return {
      generationId: response.result,
      status: "processing",
    }
  }

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
      this.log.error("meshy api error", { status: response.status, body: text })
      throw new Error(`Meshy API error ${response.status}: ${text}`)
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
