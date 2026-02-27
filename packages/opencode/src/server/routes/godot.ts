import { Hono } from "hono"
import { Log } from "../../util/log"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../project/instance"
import { readProfile, writeProfile } from "../../provider/asset/style-profile"
import { AssetProviderRegistry } from "../../provider/asset"
import { AssetMetadata } from "../../provider/asset/metadata"
import type { AssetProvider } from "../../provider/asset/asset-provider"

const log = Log.create({ service: "godot.commands" })

// ── In-memory command queue (per-directory) ─────────────────────────────────
// Commands are queued by AI tools and consumed by Godot editor polling.

interface GodotCommand {
  action: string
  params: Record<string, any>
  timestamp: number
}

const commandQueues = new Map<string, GodotCommand[]>()

// ── In-memory screenshot result store ───────────────────────────────────────
// Screenshot results are posted by Godot editor and consumed by the tool.

interface ScreenshotResult {
  data: string // base64-encoded PNG
  timestamp: number
}

const screenshotResults = new Map<string, ScreenshotResult>()

export namespace GodotScreenshots {
  /** Store a screenshot result from Godot editor. */
  export function store(id: string, data: string) {
    screenshotResults.set(id, { data, timestamp: Date.now() })
    // Auto-cleanup after 60 seconds
    setTimeout(() => screenshotResults.delete(id), 60_000)
  }

  /** Poll for a screenshot result. Returns null if not ready yet. */
  export function get(id: string): string | null {
    return screenshotResults.get(id)?.data ?? null
  }
}

export namespace GodotCommands {
  /** Push a command for a specific Godot project directory. */
  export function push(directory: string, action: string, params: Record<string, any> = {}) {
    const key = normalizeDir(directory)
    if (!commandQueues.has(key)) {
      commandQueues.set(key, [])
    }
    const cmd: GodotCommand = { action, params, timestamp: Date.now() }
    commandQueues.get(key)!.push(cmd)
    log.info("queued", { directory: key, action, params })
  }

  /** Drain all pending commands for a directory (returns and clears). */
  export function drain(directory: string): GodotCommand[] {
    const key = normalizeDir(directory)
    const queue = commandQueues.get(key)
    if (!queue || queue.length === 0) return []
    const commands = [...queue]
    queue.length = 0
    log.info("drained", { directory: key, count: commands.length })
    return commands
  }

  function normalizeDir(dir: string): string {
    return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  }
}

// ── HTTP Routes ─────────────────────────────────────────────────────────────

export function GodotRoutes() {
  return new Hono()
    // Godot editor polls this endpoint to get pending commands
    .get("/commands", async (c) => {
      const directory = c.req.query("directory") ?? ""
      if (!directory) {
        return c.json([])
      }
      const commands = GodotCommands.drain(directory)
      return c.json(commands)
    })

    // AI tools can also push commands via HTTP (alternative to direct import)
    .post("/commands", async (c) => {
      const { directory, action, params } = await c.req.json<{
        directory: string
        action: string
        params?: Record<string, any>
      }>()
      if (!directory || !action) {
        return c.json({ error: "Missing directory or action" }, 400)
      }
      GodotCommands.push(directory, action, params ?? {})
      return c.json({ success: true })
    })

    // Godot editor POSTs screenshot result here after capturing viewport
    .post("/screenshot-result", async (c) => {
      const { id, data } = await c.req.json<{ id: string; data: string }>()
      if (!id || !data) {
        return c.json({ error: "Missing id or data" }, 400)
      }
      GodotScreenshots.store(id, data)
      log.info("screenshot stored", { id })
      return c.json({ success: true })
    })

    // Tool polls this endpoint to get a screenshot result by ID
    .get("/screenshot/:id", async (c) => {
      const id = c.req.param("id")
      const data = GodotScreenshots.get(id)
      if (!data) {
        return c.json({ ready: false })
      }
      return c.json({ ready: true, data })
    })

    // ── Art Director routes ──────────────────────────────────────────────────

    // GET current style profile
    .get("/art-director/profile", async (c) => {
      const projectRoot = c.req.query("directory") ?? Instance.directory
      const profile = readProfile(projectRoot)
      if (!profile) {
        return c.json({ profile: null })
      }
      return c.json({ profile })
    })

    // POST update reference asset in style profile
    .post("/art-director/set-reference", async (c) => {
      const body = await c.req.json<{ reference_asset: string; directory?: string }>()
      const { reference_asset } = body
      if (!reference_asset) {
        return c.json({ error: "Missing reference_asset" }, 400)
      }
      const projectRoot = body.directory ?? Instance.directory
      const profile = readProfile(projectRoot)
      if (!profile) {
        return c.json({ error: "No style profile found. Set a style first." }, 404)
      }
      profile.reference_asset = reference_asset
      await writeProfile(projectRoot, profile)
      log.info("set-reference updated", { reference_asset })
      return c.json({ success: true, reference_asset })
    })

    // GET list exploration and cornerstone images
    .get("/art-director/images", async (c) => {
      const projectRoot = c.req.query("directory") ?? Instance.directory
      const images: Array<{ category: string; resPath: string; absPath: string }> = []

      const scanDir = async (category: string, absDir: string, resBase: string) => {
        try {
          const entries = await fs.readdir(absDir)
          for (const entry of entries) {
            if (/\.(png|jpg|jpeg|webp)$/i.test(entry)) {
              images.push({
                category,
                resPath: `${resBase}/${entry}`,
                absPath: path.join(absDir, entry),
              })
            }
          }
        } catch {
          // Directory doesn't exist yet — that's OK
        }
      }

      await scanDir("exploration", path.join(projectRoot, "assets", ".art_exploration"), "res://assets/.art_exploration")
      await scanDir("cornerstone", path.join(projectRoot, "assets", "cornerstone"), "res://assets/cornerstone")

      return c.json({ images })
    })

    // GET list available image generation models
    .get("/art-director/models", async (c) => {
      const models = await AssetProviderRegistry.listModels("replicate")
      return c.json({ models })
    })

    // POST start a batch generation job
    .post("/art-director/batch", async (c) => {
      const body = await c.req.json<{
        prompts: string[]
        reference_asset?: string
        output_dir: string
        asset_type?: string
        model?: string
        directory?: string
      }>()

      if (!body.prompts?.length || !body.output_dir) {
        return c.json({ error: "Missing prompts or output_dir" }, 400)
      }

      const projectRoot = body.directory ?? c.req.query("directory") ?? Instance.directory

      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const status: ArtDirectorBatch = {
        id: batchId,
        total: body.prompts.length,
        completed: 0,
        failed: 0,
        items: body.prompts.map((p, i) => ({ index: i, prompt: p, status: "pending" })),
        created_at: Date.now(),
      }
      artDirectorBatches.set(batchId, status)

      // Run async
      runArtDirectorBatch(batchId, { ...body, projectRoot }).catch((err) => {
        log.error("batch run error", { batchId, error: err.message })
      })

      return c.json({ batchId })
    })

    // GET batch status
    .get("/art-director/batch/:id", async (c) => {
      const id = c.req.param("id")
      const batch = artDirectorBatches.get(id)
      if (!batch) {
        return c.json({ error: "Batch not found" }, 404)
      }
      return c.json(batch)
    })
}

// ── Batch state ──────────────────────────────────────────────────────────────

interface ArtDirectorBatchItem {
  index: number
  prompt: string
  status: "pending" | "generating" | "completed" | "failed"
  resPath?: string
  error?: string
}

interface ArtDirectorBatch {
  id: string
  total: number
  completed: number
  failed: number
  items: ArtDirectorBatchItem[]
  created_at: number
}

const artDirectorBatches = new Map<string, ArtDirectorBatch>()

async function runArtDirectorBatch(
  batchId: string,
  params: {
    prompts: string[]
    reference_asset?: string
    output_dir: string
    asset_type?: string
    model?: string
    projectRoot: string
  },
): Promise<void> {
  const batch = artDirectorBatches.get(batchId)!
  const projectRoot = params.projectRoot
  const profile = readProfile(projectRoot)

  const refAsset = params.reference_asset ?? profile?.reference_asset
  const artDirection = profile?.art_direction ?? ""
  const modelId = params.model ?? (refAsset ? "flux-kontext-pro" : "flux-2-dev")
  const assetType = (params.asset_type ?? "texture") as AssetProvider.AssetType

  const resolved = await AssetProviderRegistry.resolveModel(assetType, modelId)
  if (!resolved) {
    for (const item of batch.items) {
      item.status = "failed"
      item.error = "No provider configured"
    }
    batch.failed = batch.total
    return
  }

  const destDir = params.output_dir.startsWith("res://")
    ? path.join(projectRoot, params.output_dir.slice(6))
    : params.output_dir
  await fs.mkdir(destDir, { recursive: true })

  const CONCURRENCY = 3
  const items = batch.items

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const chunk = items.slice(i, i + CONCURRENCY)

    await Promise.all(
      chunk.map(async (item) => {
        item.status = "generating"
        const slug = `batch_${String(item.index + 1).padStart(3, "0")}`
        const filename = `${slug}.png`
        const destPath = path.join(destDir, filename)
        const resPath = `${params.output_dir.replace(/\/$/, "")}/${filename}`

        const fullPrompt = artDirection ? `${artDirection}. ${item.prompt}` : item.prompt
        const genParams: Record<string, unknown> = {}
        if (refAsset) genParams.input_image = refAsset

        try {
          const result = await resolved.provider.generate({
            type: assetType,
            prompt: fullPrompt,
            model: resolved.modelId,
            parameters: genParams,
          })

          let status = result
          let attempts = 0
          while ((status.status === "pending" || status.status === "processing") && attempts < 120) {
            await new Promise((resolve) => setTimeout(resolve, 2000))
            status = await resolved.provider.checkStatus(result.generationId)
            attempts++
          }

          if (status.status === "completed") {
            const bundle = await resolved.provider.download(result.generationId)
            if (bundle.assets.length > 0) {
              await fs.writeFile(destPath, bundle.assets[0].data)

              const metadata: AssetProvider.AssetMetadata = {
                origin: "generated",
                asset_type: assetType,
                prompt: fullPrompt,
                provider: resolved.provider.id,
                model: resolved.modelId,
                generation_id: result.generationId,
                parameters: genParams,
                created_at: new Date().toISOString(),
                version: 1,
              }
              await AssetMetadata.write(destPath, metadata)

              item.status = "completed"
              item.resPath = resPath
              batch.completed++
            } else {
              item.status = "failed"
              item.error = "Empty output"
              batch.failed++
            }
          } else {
            item.status = "failed"
            item.error = `Generation ended with status: ${status.status}`
            batch.failed++
          }
        } catch (err: any) {
          item.status = "failed"
          item.error = err.message
          batch.failed++
        }
      })
    )
  }

  // Auto-cleanup after 10 minutes
  setTimeout(() => artDirectorBatches.delete(batchId), 600_000)
}
