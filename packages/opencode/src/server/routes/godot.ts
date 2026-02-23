import { Hono } from "hono"
import { Log } from "../../util/log"

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
}
