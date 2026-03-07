import { Log } from "../../util/log"
import { AssetProvider } from "./asset-provider"
import { getModelDefaults } from "../../config/model-defaults"

/**
 * Suno provider for AI music and sound effect generation.
 *
 * Uses third-party Suno API (sunoapi.org compatible) since Suno
 * does not yet provide an official API.
 *
 * Supports text-to-music and text-to-sfx generation.
 */
export class SunoProvider implements AssetProvider.Provider {
  readonly id = "suno"
  readonly name = "Suno AI"
  readonly supportedTypes: AssetProvider.AssetType[] = ["audio_sfx", "audio_music"]

  private apiUrl: string
  private apiKey: string
  private log = Log.create({ service: "asset.suno" })

  constructor(config: { apiKey: string; apiUrl?: string }) {
    this.apiKey = config.apiKey
    this.apiUrl = config.apiUrl ?? "https://api.sunoapi.org/v1"
  }

  async listModels(): Promise<AssetProvider.ModelInfo[]> {
    return [
      {
        id: "suno-v5",
        name: "Suno V5",
        description: "Latest model — studio-quality music with realistic vocals",
        supportedTypes: ["audio_music"],
        parameters: [
          {
            name: "duration",
            type: "number",
            description: "Target duration in seconds",
            default: 60,
            min: 10,
            max: 300,
          },
          {
            name: "instrumental",
            type: "boolean",
            description: "Generate instrumental only (no vocals)",
            default: false,
          },
          {
            name: "genre",
            type: "string",
            description: "Music genre hint (e.g., 'electronic', 'rock', 'orchestral')",
            default: "",
          },
        ],
      },
      {
        id: "suno-v4",
        name: "Suno V4",
        description: "Previous generation, faster and lower cost",
        supportedTypes: ["audio_music"],
        parameters: [
          {
            name: "duration",
            type: "number",
            description: "Target duration in seconds",
            default: 30,
            min: 10,
            max: 120,
          },
          {
            name: "instrumental",
            type: "boolean",
            description: "Generate instrumental only",
            default: false,
          },
        ],
      },
      {
        id: "suno-sfx",
        name: "Suno SFX",
        description: "Sound effect generation for game audio",
        supportedTypes: ["audio_sfx"],
        parameters: [
          {
            name: "duration",
            type: "number",
            description: "Target duration in seconds",
            default: 5,
            min: 1,
            max: 30,
          },
        ],
      },
    ]
  }

  async generate(request: AssetProvider.GenerationRequest): Promise<AssetProvider.GenerationResult> {
    const model = request.model ?? (request.type === "audio_sfx" ? getModelDefaults().audio_sfx : getModelDefaults().audio_music)

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      duration: request.parameters.duration ?? (request.type === "audio_sfx" ? 5 : 60),
    }

    if (request.parameters.instrumental !== undefined) {
      body.instrumental = request.parameters.instrumental
    }
    if (request.parameters.genre) {
      body.genre = request.parameters.genre
    }

    this.log.info("creating audio generation task", { model, type: request.type, prompt: request.prompt })

    const response = await this.request("POST", "/music/generate", body)

    return {
      generationId: response.id || response.task_id,
      status: "processing",
    }
  }

  async checkStatus(generationId: string): Promise<AssetProvider.GenerationStatus> {
    const task = await this.request("GET", `/music/tasks/${generationId}`)

    const statusMap: Record<string, AssetProvider.GenerationStatus["status"]> = {
      pending: "pending",
      queued: "pending",
      processing: "processing",
      generating: "processing",
      succeeded: "completed",
      completed: "completed",
      failed: "failed",
      error: "failed",
    }

    return {
      generationId,
      status: statusMap[task.status] ?? "processing",
      progress: task.progress ?? 0,
      message: task.error?.message,
    }
  }

  async download(generationId: string): Promise<AssetProvider.AssetBundle> {
    const task = await this.request("GET", `/music/tasks/${generationId}`)

    if (!task.audio_url && !task.data?.audio_url) {
      throw new Error(`No audio available for task ${generationId}`)
    }

    const audioUrl = task.audio_url || task.data.audio_url
    const audioData = await this.downloadFile(audioUrl)

    // Determine file extension from URL or default to mp3
    const ext = audioUrl.match(/\.(mp3|wav|ogg|flac)(\?|$)/)?.[1] ?? "mp3"

    const assets: AssetProvider.BundleAsset[] = [
      {
        type: task.model?.includes("sfx") ? "audio_sfx" : "audio_music",
        role: "primary",
        data: audioData,
        filename: `audio.${ext}`,
        metadata: {
          duration: task.duration,
          title: task.title,
        },
      },
    ]

    return {
      bundleId: generationId,
      assets,
    }
  }

  supportsTransform(_transform: AssetProvider.TransformType): boolean {
    // Suno does not support transforms on existing audio
    return false
  }

  async transform(_request: AssetProvider.TransformRequest): Promise<AssetProvider.GenerationResult> {
    throw new Error("Suno does not support asset transforms")
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
      this.log.error("suno api error", { status: response.status, body: text })
      throw new Error(`Suno API error ${response.status}: ${text}`)
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
