import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { generateText } from "ai"
import { getModelDefaults } from "../config/model-defaults"

// =============================================================================
// Helpers
// =============================================================================

function resolveResPath(resPath: string): string {
  if (resPath.startsWith("res://")) {
    return path.join(Instance.directory, resPath.slice(6))
  }
  return resPath
}

function buildMeasurementPrompt(params: {
  refWidth: number
  refHeight: number
  viewportWidth: number
  viewportHeight: number
  scaleFactor: number
  fontName: string
  panelDescription: string
}): string {
  const { refWidth, refHeight, viewportWidth, viewportHeight, scaleFactor, fontName, panelDescription } = params
  const scaleStr = scaleFactor.toFixed(4)

  return `# UI Reference Image Measurement Task

You are measuring a UI reference image to extract **pixel-precise** layout data for replication
as a Godot .tscn scene file. Be systematic and **exhaustive** — miss nothing.

## CRITICAL: Measure EVERY Visual Element

You MUST measure **every single visual element** visible in the image, no matter how small:
- **Backgrounds**: panel backgrounds, section backgrounds, nested container backgrounds
- **Borders**: outer borders, inner borders, divider lines, separator lines
- **Decorations**: corner ornaments, icons, badges, dots, arrows, shadows, glows
- **Spacing elements**: gaps, margins, padding — measure the actual pixel values
- **Text**: every label, title, subtitle, button text, placeholder text
- **Interactive elements**: buttons, input fields, checkboxes, sliders, toggles
- **Images/Icons**: every icon, thumbnail, avatar, logo — note exact size and position

Do NOT skip any element. Do NOT approximate — measure to the nearest pixel.
If an element is partially transparent or has opacity, note the opacity value.

## Input Parameters

- **Viewport**: ${viewportWidth}×${viewportHeight} (target rendering resolution)
- **Reference image resolution**: ${refWidth}×${refHeight} (measured from the image file)
- **Scale factor**: viewport_height / reference_height = ${viewportHeight} / ${refHeight} = **${scaleStr}×**
- **Font**: ${fontName}
- **Panel type**: ${panelDescription}

## Step 1: Identify Top-Level Layout Structure

Describe the overall layout skeleton:
- What is the root layout direction? (horizontal split? vertical split? overlay?)
- How many top-level regions exist?
- What are their relative proportions?

Describe the layout like:
\`\`\`
[Region A] | [Region B] | [Region C]
   ~X%     |    ~Y%     |    ~Z%
\`\`\`

Output a table:

| Region Name | Layout Role | Approx % of Total |
|---|---|---|

## Step 2: Measure Each Top-Level Region (in reference pixels)

For EACH region, measure:
1. **Bounding box**: x, y, width, height (in reference image pixels)
2. **Background color**: sample the dominant color (hex)
3. **Border**: color, approximate width, corner radius
4. **Padding/margin**: internal spacing from border to content

Format as a table:

| Region | x | y | w | h | bg_color | border_color | border_w | corner_r | padding |
|--------|---|---|---|---|----------|--------------|----------|----------|---------|

## Step 3: Measure Child Elements Within Each Region

For each region, enumerate **ALL** child elements — including backgrounds, borders, separators,
decorative elements, and any visual detail no matter how small. If you can see it, measure it.

For each element measure in REFERENCE pixels (to the nearest pixel):
- Element type (Label, Button, TextureRect/icon, ColorRect/separator, ProgressBar, PanelContainer, HSeparator, etc.)
- Position relative to region (x_offset, y_offset from region top-left)
- Size: width × height (exact pixels, not approximate)
- Content (text string if label/button, color if block, description if icon/image)
- Font size estimate (if text element)
- Text/foreground color (hex, sample the actual pixel color)
- Background color (hex, if applicable — include even subtle backgrounds)
- Border (color, width, style — even 1px borders must be captured)
- Corner radius (exact pixels, if rounded)
- Any special notes (bold, italic, alignment, opacity, gradient, shadow, glow, etc.)

Output per region:

### Region: {name}
| # | Type | x | y | Width | Height | Content | Font Size | FG Color | BG Color | Border | Corner Radius | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Step 4: Measure Spacing Patterns

Extract ALL recurring spacing values in REFERENCE pixels:

| Pattern | Reference px | Where used |
|---------|-------------|------------|

Look for:
- Gap between sibling elements in vertical lists
- Gap between sibling elements in horizontal rows
- Padding inside containers vs margin outside
- Any consistent spacing rhythm (e.g., "8px base unit")

## Step 5: Extract Color Palette

| Color Name/Role | Hex | Usage |
|------|-----|-------|

List ALL distinct colors used in the panel.

## Step 6: Compute Final Scaled Values

Apply scale_factor to EVERY measurement:

\`\`\`
scaled_value = round(reference_value × ${scaleStr})
\`\`\`

Reproduce the Step 2 table with SCALED values:

| Region | x | y | w | h | bg_color | border_w | corner_r | padding |
|--------|---|---|---|---|----------|----------|----------|---------|

Reproduce the Step 3 tables with SCALED values:

### Region: {name} (SCALED for ${viewportWidth}×${viewportHeight})
| # | Type | x | y | Width | Height | Font Size | Corner Radius | Notes |
|---|---|---|---|---|---|---|---|---|

Scale Step 4 spacing values:

| Pattern | Reference (px) | Scaled (px) |
|---|---|---|

## Step 7: Space Budget Verification

Verify the math adds up:

1. Start with viewport dimensions: ${viewportWidth}×${viewportHeight}
2. Subtract outer margins (scaled): top + bottom (and left + right)
3. Subtract outer border (scaled): top + bottom
4. Subtract outer padding (scaled): top + bottom
5. Subtract gaps between top-level regions: (N-1) × gap_scaled
6. = Available content space
7. Sum of all region sizes (scaled) must equal available space
8. If mismatch, adjust the largest region to compensate

Output the budget:

| Item | Value |
|---|---|
| Viewport height | ${viewportHeight} |
| - Outer margin (top + bottom) | ... |
| - Outer border (top + bottom) | ... |
| - Outer padding (top + bottom) | ... |
| - Gaps ((N-1) × gap) | ... |
| = Available content height | ... |
| Sum of region heights | ... |
| Difference (must be 0) | ... |

Do the same for width if there are horizontal regions.

## Final Summary Table

Produce one comprehensive flat list of ALL nodes for the .tscn file:

| Node Path | Type | custom_minimum_size | Position/Offset | Font Size | Colors (FG/BG) | Separation | Corner Radius | Content |
|---|---|---|---|---|---|---|---|---|

Use Godot node paths like "Root/MarginContainer/VBox/Header/TitleLabel".
All values in this table must be SCALED (final viewport pixels).
Map element types to Godot node types:
- Text → Label
- Button → Button
- Image/Icon → TextureRect (placeholder ColorRect)
- Container/Panel → PanelContainer
- Color block → ColorRect
- Progress bar → ProgressBar
- Horizontal group → HBoxContainer
- Vertical group → VBoxContainer
- Spacing/margin → MarginContainer`
}

// =============================================================================
// godot_ui_measure — Vision-based UI layout measurement
// =============================================================================

const DESCRIPTION = `Measure a UI reference/cornerstone image and return precise layout data for building a Godot .tscn scene.

This tool sends the reference image to an LLM with a structured measurement prompt. It returns:
- Top-level layout structure and regions
- Per-element measurements (position, size, colors, fonts)
- Spacing patterns
- Color palette
- All values scaled to the target viewport resolution
- Space budget verification
- A final summary table of all nodes for the .tscn file

Call this INSTEAD of manually measuring sections. Use the returned data to write the .tscn directly.

The LLM model used for measurement is configured in makabaka-models.json via the "ui_measure_llm" field. If not set, uses the session's default model.`

export const GodotUIMeasureTool = Tool.define("godot_ui_measure", {
  description: DESCRIPTION,
  parameters: z.object({
    reference_image: z
      .string()
      .describe("Path to the cornerstone/reference image (absolute path or res:// path)"),
    viewport_width: z
      .number()
      .int()
      .positive()
      .describe("Target viewport width in pixels (from project.godot display/window/size/viewport_width)"),
    viewport_height: z
      .number()
      .int()
      .positive()
      .describe("Target viewport height in pixels (from project.godot display/window/size/viewport_height)"),
    panel_description: z
      .string()
      .optional()
      .describe("Brief description of the UI panel, e.g. 'shop panel', 'main menu', 'HUD overlay'. Helps the LLM understand context."),
    font_name: z
      .string()
      .optional()
      .describe("Primary font name used in the project, e.g. 'PressStart2P.ttf (pixel font, monospaced)'. Helps estimate font sizes."),
  }),
  async execute(params, ctx) {
    // 1. Resolve image path
    const absImagePath = resolveResPath(params.reference_image)

    // 2. Read image and get dimensions
    const sharp = (await import("sharp")).default
    let imageBuffer: Buffer
    try {
      imageBuffer = Buffer.from(await fs.readFile(absImagePath))
    } catch (err: any) {
      return {
        title: "Image read failed",
        metadata: { error: err.message },
        output: `Failed to read reference image at ${absImagePath}: ${err.message}`,
      }
    }

    const meta = await sharp(imageBuffer).metadata()
    const refWidth = meta.width!
    const refHeight = meta.height!
    const scaleFactor = params.viewport_height / refHeight

    ctx.metadata({
      title: `Measuring UI: ${refWidth}×${refHeight} → ${params.viewport_width}×${params.viewport_height} (${scaleFactor.toFixed(2)}×)`,
    })

    // 3. Build measurement prompt
    const measurementPrompt = buildMeasurementPrompt({
      refWidth,
      refHeight,
      viewportWidth: params.viewport_width,
      viewportHeight: params.viewport_height,
      scaleFactor,
      fontName: params.font_name || "default Godot font",
      panelDescription: params.panel_description || "UI panel",
    })

    // 4. Call LLM with vision
    const defaults = getModelDefaults()
    let resultText: string
    let modelUsed: string

    if (defaults.ui_measure_api_base && defaults.ui_measure_api_key && defaults.ui_measure_model) {
      // Direct API call (e.g. Volcengine Ark / Doubao)
      modelUsed = defaults.ui_measure_model
      try {
        console.log(`[godot_ui_measure] Calling custom API (base=${defaults.ui_measure_api_base}, model=${modelUsed})...`)

        // Encode image to base64 data URL
        const base64 = imageBuffer.toString("base64")
        const mimeType = absImagePath.endsWith(".png") ? "image/png" : "image/jpeg"
        const dataUrl = `data:${mimeType};base64,${base64}`

        // Ark/Doubao uses OpenAI Responses API format with input_image/input_text content types
        const apiUrl = `${defaults.ui_measure_api_base}/responses`
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${defaults.ui_measure_api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: defaults.ui_measure_model,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_image",
                    image_url: dataUrl,
                  },
                  {
                    type: "input_text",
                    text: measurementPrompt,
                  },
                ],
              },
            ],
            temperature: 0.2,
            max_output_tokens: 20000,
            thinking: {
              type: "enabled",
            },
          }),
        })

        if (!response.ok) {
          const errBody = await response.text()
          throw new Error(`API returned ${response.status}: ${errBody}`)
        }

        const json = await response.json() as any

        // Extract text from Responses API output
        // Format: { output: [ { type: "message", content: [ { type: "output_text", text: "..." } ] } ] }
        resultText = ""
        if (json.output) {
          for (const item of json.output) {
            if (item.type === "message" && item.content) {
              for (const part of item.content) {
                if (part.type === "output_text" && part.text) {
                  resultText += part.text
                }
              }
            }
          }
        }
        // Fallback: check for choices format (standard OpenAI chat completions)
        if (!resultText && json.choices?.[0]?.message?.content) {
          resultText = json.choices[0].message.content
        }

        if (!resultText) {
          throw new Error(`Unexpected API response structure: ${JSON.stringify(json).slice(0, 500)}`)
        }

        console.log(`[godot_ui_measure] Custom API returned ${resultText.length} chars`)
      } catch (err: any) {
        console.error(`[godot_ui_measure] Custom API error:`, err)
        return {
          title: "LLM measurement failed",
          metadata: { error: err.message },
          output: `Failed to call custom measurement API: ${err.message}\n\nStack: ${err.stack || "none"}`,
        }
      }
    } else {
      // Use provider system (default LLM or configured ui_measure_llm)
      const defaultModel = await Provider.defaultModel()
      let model
      if (defaults.ui_measure_llm) {
        model = await Provider.getModel(defaultModel.providerID, defaults.ui_measure_llm)
      } else {
        model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
      }
      const language = await Provider.getLanguage(model)
      modelUsed = defaults.ui_measure_llm || defaultModel.modelID

      try {
        console.log(`[godot_ui_measure] Calling LLM (provider=${defaultModel.providerID}, model=${model.id})...`)
        const result = await generateText({
          model: language,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: measurementPrompt },
                { type: "image", image: imageBuffer },
              ],
            },
          ],
          temperature: 0.2,
          maxTokens: 20000,
          providerOptions: {
            anthropic: {
              thinking: { type: "enabled", budgetTokens: 16000 },
            },
          },
        })
        resultText = result.text
        console.log(`[godot_ui_measure] LLM returned ${resultText?.length ?? 0} chars, finishReason=${result.finishReason}`)
      } catch (err: any) {
        console.error(`[godot_ui_measure] LLM error:`, err)
        return {
          title: "LLM measurement failed",
          metadata: { error: err.message },
          output: `Failed to call LLM for measurement: ${err.message}\n\nStack: ${err.stack || "none"}`,
        }
      }
    }

    // 5. Return structured output
    const header = [
      `## UI Measurement Results`,
      ``,
      `- **Reference**: ${refWidth}×${refHeight} px`,
      `- **Viewport**: ${params.viewport_width}×${params.viewport_height} px`,
      `- **Scale factor**: ${scaleFactor.toFixed(4)}×`,
      `- **Model used**: ${modelUsed}`,
      ``,
      `---`,
      ``,
    ].join("\n")

    return {
      title: `UI Measurement: ${refWidth}×${refHeight} → ${params.viewport_width}×${params.viewport_height}`,
      metadata: {
        reference_width: refWidth,
        reference_height: refHeight,
        viewport_width: params.viewport_width,
        viewport_height: params.viewport_height,
        scale_factor: scaleFactor,
        truncated: false,
      },
      output: header + resultText,
    }
  },
})
