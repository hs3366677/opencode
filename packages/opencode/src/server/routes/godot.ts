import { Hono } from "hono"
import { Log } from "../../util/log"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../project/instance"
import { readProfile, writeProfile, defaultProfile } from "../../provider/asset/style-profile"
import { getModelDefaults } from "../../config/model-defaults"
import { AssetMetadata } from "../../provider/asset/metadata"
import type { AssetProvider } from "../../provider/asset/asset-provider"
import { generateImage } from "../../provider/asset/generate-image"

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

// ── In-memory eval result store ──────────────────────────────────────────────
// Eval results are posted by Godot editor and consumed by the sim tool.

interface EvalResult {
  value: string
  error?: string
  timestamp: number
}

const evalResults = new Map<string, EvalResult>()

export namespace GodotEvalResults {
  /** Store an eval result from Godot editor. */
  export function store(id: string, value: string, error?: string) {
    evalResults.set(id, { value, error, timestamp: Date.now() })
    // Auto-cleanup after 30 seconds
    setTimeout(() => evalResults.delete(id), 30_000)
  }

  /** Poll for an eval result. Returns null if not ready yet. */
  export function get(id: string): { value: string; error?: string } | null {
    const result = evalResults.get(id)
    if (!result) return null
    return { value: result.value, error: result.error }
  }
}

// ── In-memory log result store ────────────────────────────────────────────────
// Log results are posted by Godot editor and consumed by the godot_logs tool.

interface LogResult {
  content: string
  lineCount: number
  timestamp: number
}

const logResults = new Map<string, LogResult>()

export namespace GodotLogResults {
  /** Store a log result from Godot editor. */
  export function store(id: string, content: string, lineCount: number) {
    logResults.set(id, { content, lineCount, timestamp: Date.now() })
    // Auto-cleanup after 30 seconds
    setTimeout(() => logResults.delete(id), 30_000)
  }

  /** Poll for a log result. Returns null if not ready yet. */
  export function get(id: string): { content: string; lineCount: number } | null {
    const result = logResults.get(id)
    if (!result) return null
    return { content: result.content, lineCount: result.lineCount }
  }
}

// ── In-memory record result store ─────────────────────────────────────────────
// GIF recording results: Godot posts base64 PNG frames, OpenCode encodes to GIF.

interface RecordResult {
  frames: string[] // base64-encoded PNG frames
  timestamp: number
}

const recordResults = new Map<string, RecordResult>()

export namespace GodotRecordResults {
  /** Store a recording result from Godot editor. */
  export function store(id: string, frames: string[]) {
    recordResults.set(id, { frames, timestamp: Date.now() })
    // Auto-cleanup after 120 seconds
    setTimeout(() => recordResults.delete(id), 120_000)
  }

  /** Poll for a recording result. Returns null if not ready yet. */
  export function get(id: string): string[] | null {
    const result = recordResults.get(id)
    if (!result) return null
    return result.frames
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

    // Godot editor POSTs eval result here after expression evaluation
    .post("/eval-result", async (c) => {
      const { id, value, error } = await c.req.json<{ id: string; value: string; error?: string }>()
      if (!id) {
        return c.json({ error: "Missing id" }, 400)
      }
      GodotEvalResults.store(id, value ?? "", error)
      log.info("eval result stored", { id, hasError: !!error })
      return c.json({ success: true })
    })

    // Tool polls this endpoint to get an eval result by ID
    .get("/eval/:id", async (c) => {
      const id = c.req.param("id")
      const result = GodotEvalResults.get(id)
      if (!result) {
        return c.json({ ready: false })
      }
      return c.json({ ready: true, ...result })
    })

    // Godot editor POSTs log content here after get_logs command
    .post("/log-result", async (c) => {
      const { id, content, lineCount } = await c.req.json<{ id: string; content: string; lineCount: number }>()
      if (!id) {
        return c.json({ error: "Missing id" }, 400)
      }
      GodotLogResults.store(id, content ?? "", lineCount ?? 0)
      log.info("log result stored", { id, lineCount })
      return c.json({ success: true })
    })

    // Tool polls this endpoint to get a log result by ID
    .get("/log/:id", async (c) => {
      const id = c.req.param("id")
      const result = GodotLogResults.get(id)
      if (!result) {
        return c.json({ ready: false })
      }
      return c.json({ ready: true, ...result })
    })

    // Godot editor POSTs recording frames here after F10 stop
    // Accepts either { id, frames: base64[] } or { id, framePaths: string[], fps }
    .post("/record-result", async (c) => {
      const body = await c.req.json<{ id: string; frames?: string[]; framePaths?: string[]; fps?: number }>()
      const { id } = body
      if (!id) {
        return c.json({ error: "Missing id" }, 400)
      }

      let frames: string[]
      if (body.framePaths?.length) {
        // Read frames from disk (file-based approach for large recordings)
        frames = []
        for (const fp of body.framePaths) {
          try {
            const data = await fs.readFile(fp)
            frames.push(data.toString("base64"))
          } catch (e: any) {
            log.warn("Failed to read frame file", { path: fp, error: e.message })
          }
        }
      } else if (body.frames?.length) {
        frames = body.frames
      } else {
        return c.json({ error: "Missing frames or framePaths" }, 400)
      }

      if (frames.length === 0) {
        return c.json({ error: "No frames loaded" }, 400)
      }

      GodotRecordResults.store(id, frames)
      log.info("record result stored", { id, frameCount: frames.length })

      // Encode GIF and save to temp file using sharp for PNG decoding
      const fps = body.fps || 10
      try {
        const { GIFEncoder, quantize, applyPalette } = await import("gifenc")
        const sharp = (await import("sharp")).default

        // Decode first frame to get dimensions
        const firstBuf = Buffer.from(frames[0], "base64")
        const firstMeta = await sharp(firstBuf).metadata()
        const width = firstMeta.width!
        const height = firstMeta.height!

        const gif = GIFEncoder()
        const delay = Math.round(1000 / fps)

        for (const frame of frames) {
          const buf = Buffer.from(frame, "base64")
          // Decode PNG to raw RGBA using sharp
          const rgba = await sharp(buf).ensureAlpha().raw().toBuffer()
          const palette = quantize(rgba, 256)
          const indexed = applyPalette(rgba, palette)
          gif.writeFrame(indexed, width, height, { palette, delay })
        }

        gif.finish()
        const gifBytes = gif.bytes()

        // Save GIF to temp file
        const os = await import("os")
        const gifPath = path.join(os.tmpdir(), `recording-${id}.gif`)
        await fs.writeFile(gifPath, Buffer.from(gifBytes))
        log.info("GIF encoded and saved", { id, gifPath, size: gifBytes.length, frames: frames.length })

        return c.json({ success: true, gifPath, frameCount: frames.length })
      } catch (e: any) {
        log.error("GIF encoding failed", { id, error: e.message })
        return c.json({ success: true, frameCount: frames.length, gifError: e.message })
      }
    })

    // Tool polls this endpoint to get a recording result by ID
    .get("/record/:id", async (c) => {
      const id = c.req.param("id")
      const frames = GodotRecordResults.get(id)
      if (!frames) {
        return c.json({ ready: false })
      }
      return c.json({ ready: true, frameCount: frames.length })
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
      let profile = readProfile(projectRoot)
      if (!profile) {
        // Create a default profile if none exists
        const defaults = defaultProfile()
        profile = {
          reference_asset,
          art_direction: "",
          consistency_model: defaults.consistency_model ?? "flux-kontext-pro",
          consistency_strength: defaults.consistency_strength ?? 0.7,
          palette: defaults.palette ?? [],
          created_at: defaults.created_at ?? new Date().toISOString(),
        }
      } else {
        profile.reference_asset = reference_asset
      }
      await writeProfile(projectRoot, profile)
      log.info("set-reference updated", { reference_asset })
      return c.json({ success: true, reference_asset })
    })

    // GET list exploration sessions and cornerstone images
    .get("/art-director/images", async (c) => {
      const projectRoot = c.req.query("directory") ?? Instance.directory

      // Scan image files from a directory
      const scanImages = async (absDir: string, resBase: string) => {
        const images: Array<{ resPath: string; absPath: string; label?: string; tooltip?: string }> = []
        try {
          const entries = await fs.readdir(absDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) continue
            if (entry.name.startsWith(".")) continue
            if (/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) {
              images.push({
                resPath: `${resBase}/${entry.name}`,
                absPath: path.join(absDir, entry.name),
              })
            }
          }
        } catch {
          // Directory doesn't exist yet
        }
        return images
      }

      // Scan cornerstone with metadata
      const scanCornerstone = async (absDir: string, resBase: string) => {
        const images: Array<{ resPath: string; absPath: string; label?: string; tooltip?: string }> = []
        try {
          const entries = await fs.readdir(absDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) continue
            if (entry.name.startsWith(".")) continue
            if (/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) {
              const img: { resPath: string; absPath: string; label?: string; tooltip?: string } = {
                resPath: `${resBase}/${entry.name}`,
                absPath: path.join(absDir, entry.name),
              }
              try {
                const metaDir = path.join(absDir, `.ai.${entry.name}`)
                const metaContent = await fs.readFile(path.join(metaDir, "metadata.json"), "utf-8")
                const meta = JSON.parse(metaContent)
                if (meta.prompt) {
                  const doubleDot = meta.prompt.indexOf(".. ")
                  let subject: string
                  if (doubleDot >= 0) {
                    subject = meta.prompt.slice(doubleDot + 3)
                  } else {
                    const sentences = meta.prompt.split(". ")
                    subject = sentences.length > 1 ? sentences[sentences.length - 1] : meta.prompt
                  }
                  const firstSentence = subject.split(/\.\s/)[0]
                  img.tooltip = firstSentence
                  const short = firstSentence
                    .replace(/^(Single|A|An|The|One|Small|Large|Rectangular)\s+/i, "")
                    .replace(/\s+(on|with|in|for|from|centered)\s+.*/i, "")
                    .replace(/\s+(icon|design|asset|sprite|image|texture|symbol|element)\s*$/i, "")
                  img.label = short.length > 24 ? short.slice(0, 22) + ".." : short
                }
              } catch {
                // No metadata
              }
              images.push(img)
            }
          }
        } catch {
          // Directory doesn't exist
        }
        return images
      }

      // Scan exploration sessions (subdirs of .art_exploration/)
      const explorationBase = path.join(projectRoot, "assets", ".art_exploration")
      const sessions: Array<{ id: string; images: Array<{ resPath: string; absPath: string }> }> = []

      try {
        const entries = await fs.readdir(explorationBase, { withFileTypes: true })
        // Collect session subdirs and loose files
        const sessionDirs: string[] = []
        const looseImages: Array<{ resPath: string; absPath: string }> = []

        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith("session_")) {
            sessionDirs.push(entry.name)
          } else if (!entry.isDirectory() && !entry.name.startsWith(".") && /\.(png|jpg|jpeg|webp)$/i.test(entry.name)) {
            looseImages.push({
              resPath: `res://assets/.art_exploration/${entry.name}`,
              absPath: path.join(explorationBase, entry.name),
            })
          }
        }

        // Sort session dirs newest first (session_YYYYMMDD_HHmmss)
        sessionDirs.sort((a, b) => b.localeCompare(a))

        for (const dir of sessionDirs) {
          const imgs = await scanImages(path.join(explorationBase, dir), `res://assets/.art_exploration/${dir}`)
          if (imgs.length > 0) {
            sessions.push({ id: dir, images: imgs })
          }
        }

        // Legacy loose files → "default" session at the end
        if (looseImages.length > 0) {
          sessions.push({ id: "default", images: looseImages })
        }
      } catch {
        // .art_exploration doesn't exist yet
      }

      const cornerstone = await scanCornerstone(
        path.join(projectRoot, "assets", "cornerstone"),
        "res://assets/cornerstone",
      )

      return c.json({ sessions, cornerstone })
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
  const modelId = params.model ?? getModelDefaults().image_batch
  const assetType = (params.asset_type ?? "texture") as AssetProvider.AssetType

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
          const result = await generateImage({
            type: assetType,
            prompt: fullPrompt,
            model: modelId,
            parameters: genParams,
            destPath,
          })

          if (result.success) {
            const metadata: AssetProvider.AssetMetadata = {
              origin: "generated",
              asset_type: assetType,
              prompt: fullPrompt,
              provider: result.provider,
              model: result.model,
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
            item.error = result.error ?? "Generation failed"
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
