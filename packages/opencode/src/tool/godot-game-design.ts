import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Instance } from "../project/instance"

// =============================================================================
// godot_game_design - Save core game mechanics design
// =============================================================================

const GAME_DESIGN_DESCRIPTION = `Save the game design results from the conversation to docs/game_design.md.

Call this AFTER completing the core game fun design dialogue with the user.
This tool saves the game mechanics, gameplay loop, win/lose conditions, and progression design.

Do NOT call this before asking the user the game design questions.`

export const GodotGameDesignTool = Tool.define("godot_game_design", {
  description: GAME_DESIGN_DESCRIPTION,
  parameters: z.object({
    game_title: z.string().describe("Working title for the game"),
    genre: z.string().describe("Primary genre/type (e.g., '2D platformer', 'top-down roguelike')"),
    core_action: z.string().describe("The ONE action the player does most — the core verb"),
    action_depth: z.string().describe("What makes the core action interesting/varied every time"),
    fail_stakes: z.string().describe("What the player loses on failure — connected to world rule"),
    gameplay_loop: z.string().describe("The core loop: what player does repeatedly (action → reward → challenge → repeat)"),
    win_condition: z.string().describe("How the player wins or completes the game"),
    progression: z.string().describe("How the player gets stronger/advances — tied to world mechanics"),
    unique_mechanic: z
      .string()
      .optional()
      .describe("A mechanic unique to THIS game that couldn't exist in another world"),
  }),
  async execute(params) {
    const projectRoot = Instance.directory
    const docsDir = path.join(projectRoot, "docs")
    await fs.mkdir(docsDir, { recursive: true })

    const sections = [
      `# ${params.game_title} — Game Design Document\n`,
      `## Genre\n${params.genre}\n`,
      `## Core Action\n${params.core_action}\n`,
      `## Action Depth\n${params.action_depth}\n`,
      `## Failure Stakes\n${params.fail_stakes}\n`,
      `## Gameplay Loop\n${params.gameplay_loop}\n`,
      `## Win Condition\n${params.win_condition}\n`,
      `## Progression\n${params.progression}\n`,
    ]
    if (params.unique_mechanic) {
      sections.push(`## Unique Mechanic\n${params.unique_mechanic}\n`)
    }
    const md = sections.join("\n")

    const gdPath = path.join(docsDir, "game_design.md")
    await fs.writeFile(gdPath, md)

    return {
      title: `Game design saved: ${params.game_title}`,
      metadata: { game_title: params.game_title, genre: params.genre },
      output: `Saved game design to docs/game_design.md\n\nCore loop: ${params.core_action} → ${params.action_depth}\nStakes: ${params.fail_stakes}\n\nProceed to scaffolding phase.`,
    }
  },
})

// =============================================================================
// godot_creation_progress - Track game creation workflow progress
// =============================================================================

const CREATION_PROGRESS_DESCRIPTION = `Update the game creation progress tracker.

Call this after completing each phase of the game creation workflow:
- "worldbuilding" — after godot_worldbuilding saves results
- "art_direction" — after godot_style_set locks in the visual style
- "game_design" — after godot_game_design saves mechanics
- "scaffolding" — after initial project structure is generated
- "asset_generation" — after real art assets replace all placeholders

This helps the AI resume from the correct phase if the session is interrupted.`

export const GodotCreationProgressTool = Tool.define("godot_creation_progress", {
  description: CREATION_PROGRESS_DESCRIPTION,
  parameters: z.object({
    phase: z.enum(["worldbuilding", "art_direction", "game_design", "scaffolding", "asset_generation"]).describe("The phase that was just completed"),
    status: z.enum(["started", "completed", "skipped"]).describe("Status of the phase"),
    notes: z.string().optional().describe("Optional notes about what was accomplished"),
  }),
  async execute(params) {
    const projectRoot = Instance.directory
    const docsDir = path.join(projectRoot, "docs")
    await fs.mkdir(docsDir, { recursive: true })

    const progressPath = path.join(docsDir, "creation_progress.md")

    // Read existing progress or create new
    let existing = ""
    try {
      existing = await fs.readFile(progressPath, "utf-8")
    } catch {
      // File doesn't exist yet
    }

    const timestamp = new Date().toISOString().split("T")[0]
    const statusEmoji = params.status === "completed" ? "done" : params.status === "started" ? "in progress" : "skipped"
    const entry = `- [${statusEmoji}] **${params.phase}** (${timestamp})${params.notes ? ` — ${params.notes}` : ""}`

    if (existing.includes(`**${params.phase}**`)) {
      // Update existing phase entry
      const lines = existing.split("\n")
      const updated = lines.map((line) => (line.includes(`**${params.phase}**`) ? entry : line))
      await fs.writeFile(progressPath, updated.join("\n"))
    } else {
      // Append new phase
      if (!existing) {
        existing = "# Game Creation Progress\n\n"
      }
      await fs.writeFile(progressPath, existing + entry + "\n")
    }

    const phaseOrder = ["worldbuilding", "art_direction", "game_design", "scaffolding", "asset_generation"]
    const currentIdx = phaseOrder.indexOf(params.phase)
    const nextPhase = currentIdx < phaseOrder.length - 1 ? phaseOrder[currentIdx + 1] : null

    let output = `Progress updated: ${params.phase} → ${params.status}`
    if (nextPhase && params.status === "completed") {
      output += `\n\nNext phase: ${nextPhase}`
    } else if (params.phase === "asset_generation" && params.status === "completed") {
      output += "\n\nAll phases complete! The game prototype is ready."
    }

    return {
      title: `Progress: ${params.phase} ${statusEmoji}`,
      metadata: { phase: params.phase, status: params.status },
      output,
    }
  },
})
