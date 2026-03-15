import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { GodotCommands } from "../server/routes/godot"

const DESCRIPTION = `Send commands to the Godot editor to manage project files and editor state.

Use this tool to interact with the running Godot editor. Commands are queued and
executed by Godot on its next poll cycle (typically within 500ms).

Available actions:
- **scan_filesystem**: Refresh the Godot FileSystem dock to detect newly created/modified files.
  IMPORTANT: Always call this after creating or modifying project files (scripts, scenes, resources)
  so Godot can detect the changes.
- **reload_scene**: Reload the currently open scene to pick up external changes

Typical workflow after creating game files:
1. Use write/edit tools to create .gd scripts and .tscn scenes
2. Call godot_editor_command with action "scan_filesystem"`

export const GodotEditorCommandTool = Tool.define("godot_editor_command", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z
      .enum(["scan_filesystem", "reload_scene"])
      .describe("The editor action to execute"),
  }),
  async execute(params, ctx) {
    const directory = Instance.directory
    GodotCommands.push(directory, params.action, {})

    const descriptions: Record<string, string> = {
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

const TEST_DESCRIPTION = `Run or stop the Godot game for testing.

Use this tool to launch and stop the game during auto-test verification.

Available actions:
- **run**: Run the game (main scene or a specific scene)
- **stop**: Stop the running game

Typical auto-test workflow:
1. Call godot_editor_command with "scan_filesystem" to detect file changes
2. Call godot_test_command with "run" to launch the game
3. Use godot_screenshot or sim to verify behavior
4. Call godot_test_command with "stop" when done`

export const GodotTestCommandTool = Tool.define("godot_test_command", {
  description: TEST_DESCRIPTION,
  parameters: z.object({
    action: z
      .enum(["run", "stop"])
      .describe("The test action to execute"),
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
    }

    return {
      title: descriptions[params.action] ?? `Queued: ${params.action}`,
      metadata: { action: params.action, directory },
      output: descriptions[params.action] ?? `Command "${params.action}" queued for Godot editor.`,
    }
  },
}, { testOnly: true })
