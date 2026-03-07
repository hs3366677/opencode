import fs from "fs/promises"
import path from "path"
import { Log } from "../../util/log"
import { AssetProviderRegistry } from "./index"
import type { AssetProvider } from "./asset-provider"

const log = Log.create({ service: "generate-image" })

export interface GenerateImageOptions {
  type: AssetProvider.AssetType
  prompt: string
  negativePrompt?: string
  model?: string
  parameters?: Record<string, unknown>
  destPath: string
  abortSignal?: AbortSignal
  pollInterval?: number
  maxPollAttempts?: number
}

export interface GenerateImageResult {
  success: boolean
  destPath: string
  generationId: string
  provider: string
  model: string
  fileSize: number
  /** Raw image data buffer (only present on success). */
  data?: Buffer
  error?: string
}

/**
 * Unified image generation: resolve model → generate → poll → download → write file.
 *
 * Does NOT write metadata or post-process — callers handle that.
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const pollInterval = opts.pollInterval ?? 2000
  const maxPoll = opts.maxPollAttempts ?? 120

  const resolved = await AssetProviderRegistry.resolveModel(opts.type, opts.model)
  if (!resolved) {
    return {
      success: false,
      destPath: opts.destPath,
      generationId: "",
      provider: "",
      model: opts.model ?? "",
      fileSize: 0,
      error: `No provider configured for type "${opts.type}"`,
    }
  }

  const { provider, modelId } = resolved
  log.info("generate", { provider: provider.id, model: modelId, prompt: opts.prompt.slice(0, 80) })

  const genResult = await provider.generate({
    type: opts.type,
    prompt: opts.prompt,
    negativePrompt: opts.negativePrompt,
    model: modelId,
    parameters: opts.parameters ?? {},
  })

  // Poll until complete
  let status = genResult
  let attempts = 0
  while ((status.status === "pending" || status.status === "processing") && attempts < maxPoll) {
    if (opts.abortSignal?.aborted) {
      return {
        success: false,
        destPath: opts.destPath,
        generationId: genResult.generationId,
        provider: provider.id,
        model: modelId,
        fileSize: 0,
        error: "Aborted",
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval))
    status = await provider.checkStatus(genResult.generationId)
    attempts++
  }

  if (status.status !== "completed") {
    return {
      success: false,
      destPath: opts.destPath,
      generationId: genResult.generationId,
      provider: provider.id,
      model: modelId,
      fileSize: 0,
      error: status.status === "failed" ? (status.message ?? "Generation failed") : `Timed out after ${attempts} polls`,
    }
  }

  // Download and write
  const bundle = await provider.download(genResult.generationId)
  if (!bundle.assets.length) {
    return {
      success: false,
      destPath: opts.destPath,
      generationId: genResult.generationId,
      provider: provider.id,
      model: modelId,
      fileSize: 0,
      error: "Empty bundle — no assets returned",
    }
  }

  const data = bundle.assets[0].data
  await fs.mkdir(path.dirname(opts.destPath), { recursive: true })
  await fs.writeFile(opts.destPath, data)

  return {
    success: true,
    destPath: opts.destPath,
    generationId: genResult.generationId,
    provider: provider.id,
    model: modelId,
    fileSize: data.length,
    data: Buffer.from(data),
  }
}
