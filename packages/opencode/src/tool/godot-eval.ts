import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { GodotCommands, GodotEvalResults } from "../server/routes/godot"

const DESCRIPTION = `Execute a GDScript expression in the running Godot game and return the result.

This tool uses Godot's debug protocol to evaluate expressions in the running game process.
Use it to interact with the game at runtime when you need to:

- **Navigate menus**: \`get_node("/root/MainMenu/PlayButton").emit_signal("pressed")\`
- **Change scenes**: \`get_tree().change_scene_to_file("res://scenes/game.tscn")\`
- **Query game state**: \`get_tree().current_scene.name\`
- **Simulate input**: \`Input.action_press("ui_accept")\` then \`Input.action_release("ui_accept")\`
- **Inspect scene tree**: \`get_tree().root.get_children().map(func(n): return n.name)\`
- **Modify properties**: \`get_node("/root/Game/Player").position = Vector2(100, 200)\`
- **Call methods**: \`get_node("/root/Game").start_level(3)\`

The expression is evaluated in the context of the running game's main thread.
The game must be running (use godot_editor_command with action "run" first).

Returns the string representation of the expression's return value, or an error message.`

async function pollForEvalResult(id: string, timeoutMs: number): Promise<{ value: string; error?: string }> {
  const start = Date.now()
  const interval = 200

  while (Date.now() - start < timeoutMs) {
    const result = GodotEvalResults.get(id)
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error(
    `Eval timed out after ${timeoutMs}ms. Make sure the game is running (use godot_editor_command with action "run" first).`,
  )
}

export const GodotEvalTool = Tool.define("godot_eval", {
  description: DESCRIPTION,
  parameters: z.object({
    expression: z.string().describe("The GDScript expression to evaluate in the running game."),
  }),
  async execute(params, ctx) {
    const directory = Instance.directory
    const id = crypto.randomUUID()

    GodotCommands.push(directory, "eval", { id, expression: params.expression })

    ctx.metadata({ title: `Evaluating: ${params.expression.substring(0, 60)}${params.expression.length > 60 ? "..." : ""}` })

    let result: { value: string; error?: string }
    try {
      result = await pollForEvalResult(id, 15_000)
    } catch (err: any) {
      return {
        title: "Eval failed",
        metadata: { error: err.message },
        output: err.message,
      }
    }

    if (result.error) {
      return {
        title: "Eval error",
        metadata: { expression: params.expression, error: result.error },
        output: `Error evaluating expression: ${result.error}`,
      }
    }

    return {
      title: "Eval result",
      metadata: { expression: params.expression },
      output: result.value,
    }
  },
})
