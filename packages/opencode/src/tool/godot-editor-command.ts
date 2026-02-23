import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { GodotCommands } from "../server/routes/godot"

const DESCRIPTION = `Send commands to the Godot editor to control game execution and editor state.

Use this tool to interact with the running Godot editor. Commands are queued and
executed by Godot on its next poll cycle (typically within 500ms).

Available actions:
- **run**: Run the game (main scene or a specific scene)
- **stop**: Stop the running game
- **scan_filesystem**: Refresh the Godot FileSystem dock to detect newly created/modified files.
  IMPORTANT: Always call this after creating or modifying project files (scripts, scenes, resources)
  so Godot can detect the changes.
- **reload_scene**: Reload the currently open scene to pick up external changes

Typical workflow after creating game files:
1. Use write/edit tools to create .gd scripts and .tscn scenes
2. Call godot_editor_command with action "scan_filesystem"
3. Call godot_editor_command with action "run" to test the game`

export const GodotEditorCommandTool = Tool.define("godot_editor_command", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z
      .enum(["run", "stop", "scan_filesystem", "reload_scene"])
      .describe("The editor action to execute"),
    scene: z
      .string()
      .optional()
      .describe('Scene to run (res:// path). Only used with "run" action. Omit to run main scene.'),
  }),
  async execute(params, ctx) {
    const directory = Instance.directory
    const actionParams: Record<string, any> = {}

    if (params.action === "run" && params.scene) {
      actionParams.scene = params.scene
    }

    GodotCommands.push(directory, params.action, actionParams)

    const descriptions: Record<string, string> = {
      run: params.scene
        ? `Queued: run scene ${params.scene}`
        : "Queued: run main scene",
      stop: "Queued: stop game",
      scan_filesystem:
        "Queued: refresh Godot FileSystem dock. New/modified files will appear shortly.",
      reload_scene:
        "Queued: reload current scene in editor.",
    }

    return {
      title: descriptions[params.action] ?? `Queued: ${params.action}`,
      metadata: { action: params.action, directory },
      output: descriptions[params.action] ?? `Command "${params.action}" queued for Godot editor.`,
    }
  },
})
