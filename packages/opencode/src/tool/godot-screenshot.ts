import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { GodotCommands, GodotScreenshots } from "../server/routes/godot"
import { Identifier } from "../id/id"
import type { MessageV2 } from "../session/message-v2"
import { compressImageBase64 } from "../util/image"

const DESCRIPTION = `Capture a screenshot of the running Godot game and return it as an image for visual analysis.

Use this tool when you need to visually inspect the game to:
- Polish UI: check typography, color contrast, layout, art style consistency
- Verify that code or scene changes look correct after applying them
- Identify visual bugs, rendering issues, or UX problems
- Compare before/after across multiple captures

You can call this tool multiple times in sequence to capture different game states,
then analyze all screenshots together before deciding on fixes.

If the game is not running, the tool will return an error — use godot_editor_command
with action "run" first.`

const ANALYSIS_PROMPT = `Analyze the screenshot(s) above for visual design issues.

Check all of the following:
- **Typography**: font style matches game theme, size hierarchy (title > body > caption), contrast, spacing between numbers and units (e.g. "45 Damage" not "45damage"), no clipping
- **Color & Contrast**: UI readable against background, consistent color meaning (red=danger, gold=rare), minimum contrast ratio
- **Visual Hierarchy**: most important info is most prominent, related elements grouped, consistent spacing and alignment
- **HUD**: health/resource bars visible, stats quick to scan, no important gameplay area obscured
- **Popup/Modal** (if visible): background dimmed, clear boundary, sufficient options, hover states distinct, actions clear
- **Feedback**: state changes communicated visually, interactive elements look interactable, important objects distinct from background
- **Art Style**: UI matches game art style, consistent icon style, no mixed-resolution assets
- **Information Density**: not overcrowded, critical info at a glance

For each issue found:
1. Describe the problem specifically (e.g. "damage number font uses system font, not pixel font")
2. Explain why it matters
3. Fix it directly using the available Godot tools (edit files, modify scenes, adjust theme resources)

End with a summary of the top 3 most impactful fixes applied.`

async function pollForScreenshot(id: string, timeoutMs: number): Promise<string> {
  const start = Date.now()
  const interval = 200

  while (Date.now() - start < timeoutMs) {
    const data = GodotScreenshots.get(id)
    if (data) return data
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error(`Screenshot timed out after ${timeoutMs}ms. Make sure the game is running (use godot_editor_command with action "run" first).`)
}

export const GodotScreenshotTool = Tool.define("godot_screenshot", {
  description: DESCRIPTION,
  parameters: z.object({
    count: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(1)
      .describe("Number of screenshots to capture. Use >1 to capture multiple frames for comparison or to catch animated states."),
    interval_ms: z
      .number()
      .int()
      .min(100)
      .max(5000)
      .default(500)
      .describe("Interval in milliseconds between screenshots when count > 1."),
    focus: z
      .string()
      .optional()
      .describe('Optional: what aspect to focus analysis on, e.g. "UI readability", "level design", "character animation". Leave empty for a full visual review.'),
  }),
  async execute(params, ctx) {
    const directory = Instance.directory
    const ids: string[] = []

    // Queue screenshot commands with intervals
    for (let i = 0; i < params.count; i++) {
      const id = crypto.randomUUID()
      ids.push(id)
      GodotCommands.push(directory, "screenshot", { id })
      if (i < params.count - 1) {
        await new Promise((resolve) => setTimeout(resolve, params.interval_ms))
      }
    }

    ctx.metadata({ title: `Capturing ${params.count} screenshot${params.count > 1 ? "s" : ""}...` })

    // Wait for all screenshots in parallel (10s timeout each)
    let results: string[]
    try {
      results = await Promise.all(ids.map((id) => pollForScreenshot(id, 10_000)))
    } catch (err: any) {
      return {
        title: "Screenshot failed",
        metadata: { error: err.message },
        output: err.message,
      }
    }

    // Compress screenshots if needed (Anthropic API has 5MB limit per image)
    const attachments: MessageV2.FilePart[] = await Promise.all(
      results.map(async (data) => {
        const compressed = await compressImageBase64(data, "image/png")
        return {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file" as const,
          mime: compressed.mime,
          url: `data:${compressed.mime};base64,${compressed.data}`,
        }
      }),
    )

    const focusLine = params.focus ? `\nFocus area: **${params.focus}**\n` : ""
    const countLabel = params.count > 1 ? `${params.count} frames captured` : "Screenshot captured"

    return {
      title: countLabel,
      metadata: { count: params.count, directory },
      output: `${countLabel}.${focusLine}\n\n${ANALYSIS_PROMPT}`,
      attachments,
    }
  },
}, { testOnly: true })
