import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { GodotCommands, GodotRecordResults } from "../server/routes/godot"
import { Identifier } from "../id/id"
import type { MessageV2 } from "../session/message-v2"
const DESCRIPTION = `Retrieve the last GIF recording from the Godot game viewport.

The user toggles GIF recording with **F1** in the Godot editor while the game is running.
When recording stops, the captured frames are sent to this tool's backend.

Use this tool to:
- Retrieve and analyze the last viewport recording as an animated GIF
- Verify animations, transitions, drag effects, or any temporal game behavior
- Compare visual states across multiple frames

The tool encodes the captured PNG frames into an animated GIF and returns it as an image attachment.
If no recording is available, it will return an error.`

async function pollForRecordResult(id: string, timeoutMs: number): Promise<string[]> {
  const start = Date.now()
  const interval = 500
  while (Date.now() - start < timeoutMs) {
    const frames = GodotRecordResults.get(id)
    if (frames) return frames
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`Recording poll timed out after ${timeoutMs}ms.`)
}

async function encodeFramesToGif(base64Frames: string[], fps: number): Promise<string> {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc")
  const sharp = (await import("sharp")).default

  // Decode first frame to get dimensions
  const firstBuf = Buffer.from(base64Frames[0], "base64")
  const firstMeta = await sharp(firstBuf).metadata()
  const width = firstMeta.width!
  const height = firstMeta.height!

  const gif = GIFEncoder()
  const delay = Math.round(1000 / fps)

  for (const frame of base64Frames) {
    const buf = Buffer.from(frame, "base64")
    const rgba = await sharp(buf).ensureAlpha().raw().toBuffer()
    const palette = quantize(rgba, 256)
    const indexed = applyPalette(rgba, palette)
    gif.writeFrame(indexed, width, height, { palette, delay })
  }

  gif.finish()
  const gifBytes = gif.bytes()
  return Buffer.from(gifBytes).toString("base64")
}

export const GodotRecordTool = Tool.define("godot_record", {
  description: DESCRIPTION,
  parameters: z.object({
    recording_id: z
      .string()
      .optional()
      .describe("The recording ID to retrieve. If omitted, triggers a new recording request via the command queue."),
    duration_ms: z
      .number()
      .int()
      .min(500)
      .max(10000)
      .default(3000)
      .describe("Duration to record in milliseconds (only used when triggering a new recording)."),
    fps: z
      .number()
      .int()
      .min(2)
      .max(15)
      .default(8)
      .describe("Frames per second for the recording."),
  }),
  async execute(params, ctx) {
    const directory = Instance.directory

    // If no recording_id, trigger a new recording via command queue
    const id = params.recording_id ?? crypto.randomUUID()
    if (!params.recording_id) {
      GodotCommands.push(directory, "record", {
        id,
        duration_ms: params.duration_ms,
        fps: params.fps,
      })
    }

    ctx.metadata({ title: `Recording ${params.duration_ms}ms at ${params.fps}fps...` })

    let frames: string[]
    try {
      // Wait for recording to complete (duration + buffer for processing)
      frames = await pollForRecordResult(id, params.duration_ms + 15_000)
    } catch (err: any) {
      return {
        title: "Recording failed",
        metadata: { error: err.message },
        output: `Recording failed: ${err.message}\n\nMake sure the game is running. You can also press F1 in the editor to manually record, then call this tool to retrieve it.`,
      }
    }

    if (frames.length === 0) {
      return {
        title: "No frames captured",
        metadata: {},
        output: "Recording completed but no frames were captured. Make sure the game is running in embedded mode.",
      }
    }

    // Encode frames to animated GIF
    try {
      const gifBase64 = await encodeFramesToGif(frames, params.fps)

      const attachment: MessageV2.FilePart = {
        id: Identifier.ascending("part"),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        type: "file" as const,
        mime: "image/gif",
        url: `data:image/gif;base64,${gifBase64}`,
      }

      return {
        title: `Recording: ${frames.length} frames`,
        metadata: { frameCount: frames.length, fps: params.fps, duration: params.duration_ms },
        output: `Captured ${frames.length} frames at ${params.fps}fps (${(frames.length / params.fps).toFixed(1)}s). Analyze the animated GIF to verify game behavior.`,
        attachments: [attachment],
      }
    } catch (err: any) {
      // GIF encoding failed — return individual frames as PNGs instead
      const attachments: MessageV2.FilePart[] = frames.slice(0, 5).map((data) => ({
        id: Identifier.ascending("part"),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        type: "file" as const,
        mime: "image/png",
        url: `data:image/png;base64,${data}`,
      }))

      return {
        title: `Recording: ${frames.length} frames (as PNGs)`,
        metadata: { frameCount: frames.length, fps: params.fps, gifError: err.message },
        output: `Captured ${frames.length} frames. GIF encoding failed (${err.message}), returning first ${Math.min(5, frames.length)} frames as individual PNGs.`,
        attachments,
      }
    }
  },
}, { testOnly: true })
