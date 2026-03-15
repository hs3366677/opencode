import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { GodotCommands, GodotLogResults } from "../server/routes/godot"

const DESCRIPTION = `Read game runtime logs from the Godot editor.

Returns both output logs (print/printerr statements from the Output panel) and debugger error/warning counts.

Use this tool after running the game to:
- Check for script errors, warnings, or crashes
- Read game print() output for debugging
- Verify that game logic is executing correctly (e.g., events logged by GameLogger)

The game does NOT need to be running — this reads the editor's accumulated log buffer.
Logs persist until the editor is restarted or the Output panel is cleared.`

async function pollForLogResult(id: string, timeoutMs: number): Promise<{ content: string; lineCount: number }> {
  const start = Date.now()
  const interval = 200
  while (Date.now() - start < timeoutMs) {
    const result = GodotLogResults.get(id)
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`Log retrieval timed out after ${timeoutMs}ms.`)
}

export const GodotLogsTool = Tool.define("godot_logs", {
  description: DESCRIPTION,
  parameters: z.object({
    lines: z
      .number()
      .int()
      .min(10)
      .max(200)
      .default(50)
      .describe("Number of recent output log lines to retrieve."),
  }),
  async execute(params, ctx) {
    const directory = Instance.directory
    const id = crypto.randomUUID()

    GodotCommands.push(directory, "get_logs", { id, lines: params.lines })

    ctx.metadata({ title: `Reading logs (last ${params.lines} lines)` })

    let result: { content: string; lineCount: number }
    try {
      result = await pollForLogResult(id, 10_000)
    } catch (err: any) {
      return {
        title: "Logs failed",
        metadata: { error: err.message },
        output: err.message,
      }
    }

    if (!result.content || result.content.trim().length === 0) {
      return {
        title: "Logs (empty)",
        metadata: { lineCount: 0 },
        output: "No log output found. The game may not have produced any print() output yet.",
      }
    }

    return {
      title: `Logs (${result.lineCount} lines)`,
      metadata: { lineCount: result.lineCount },
      output: result.content,
    }
  },
}, { testOnly: true })
