import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { GodotCommands, GodotEvalResults } from "../server/routes/godot"

const DESCRIPTION = `Execute GDScript code in the running Godot game and return the result.

Supports full GDScript: \`var\`, \`if\`, \`for\`, \`while\`, \`match\`, \`return\`, lambdas, etc.
Single-line expressions auto-return their value. Multi-line code needs explicit \`return\` to capture a value.

**Available context:**
- \`scene\` = current scene root node
- \`tree\` = the SceneTree instance
- Engine singletons: \`Input\`, \`Engine\`, \`OS\`, \`DisplayServer\`, etc.
- Autoloads: \`tree.root.get_node("AutoloadName")\`

**Examples:**
- Single expression: \`scene.get_node("Player").position\`
- Multi-statement:
  \`var cards = scene.get_node("Hand").get_children()\\nvar names = []\\nfor c in cards:\\n\\tnames.append(c.name)\\nreturn names\`
- Simulate input: \`Input.action_press("ui_accept")\`

**IMPORTANT: \`expression\` vs \`expressions\` — scope isolation**
- \`expression\` (single string): Use this for code that shares variables. Supports multi-line with \\n.
- \`expressions\` (array): Each item is compiled as a **separate GDScript** with its own scope.
  Variables declared in one array item are NOT available in subsequent items.
  ONLY use \`expressions\` for independent commands that need delays between them (e.g. input simulation):
  \`expressions: ["Input.action_press(\\"ui_accept\\")", "Input.action_release(\\"ui_accept\\")"]\`
  NEVER split related code with shared variables across array items — use \`expression\` instead.

The game must be running (use godot_test_command with action "run" first).

**RULE: Read before you sim.** NEVER guess method names, property names, node paths, or signal names.
Before writing any sim expression, use Read/Grep to confirm the exact names from the source code.
Wrong: guessing \`current_score\` → right: grep for "score" in the script, find \`round_current_score\`.

**Testing tip**: Check res://test/ for test case documents with pre-written sim expressions.`

async function pollForEvalResult(id: string, timeoutMs: number): Promise<{ value: string; error?: string }> {
  const start = Date.now()
  const interval = 200

  while (Date.now() - start < timeoutMs) {
    const result = GodotEvalResults.get(id)
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error(
    `Sim timed out after ${timeoutMs}ms. Make sure the game is running (use godot_test_command with action "run" first).`,
  )
}

export const SimTool = Tool.define("sim", {
  description: DESCRIPTION,
  parameters: z.object({
    expression: z.string().optional().describe("A single GDScript expression to execute. Use `expressions` instead for multiple sequential commands."),
    expressions: z.array(z.string()).optional().describe("Array of GDScript expressions to execute sequentially. Each waits for the previous to complete."),
    delay_between_ms: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .default(100)
      .describe("Delay in milliseconds between sequential expressions. Allows time for game state to update."),
  }),
  async execute(params, ctx) {
    const directory = Instance.directory

    // Normalize: support both single `expression` and `expressions` array
    // Single expression can be multi-line (engine supports full GDScript scripts)
    const exprs: string[] = []
    if (params.expressions && params.expressions.length > 0) {
      exprs.push(...params.expressions)
    } else if (params.expression) {
      exprs.push(params.expression)
    }

    if (exprs.length === 0) {
      return {
        title: "Sim error",
        metadata: { expressions: exprs },
        output: "Error: provide either `expression` (string) or `expressions` (array).",
      }
    }

    const titleExpr = exprs.length === 1
      ? `${exprs[0].substring(0, 60)}${exprs[0].length > 60 ? "..." : ""}`
      : `${exprs.length} expressions`
    ctx.metadata({ title: `Sim: ${titleExpr}` })

    // Execute expressions sequentially
    const results: { expression: string; value?: string; error?: string }[] = []

    for (let i = 0; i < exprs.length; i++) {
      const expr = exprs[i]
      const id = crypto.randomUUID()
      GodotCommands.push(directory, "eval", { id, expression: expr })

      let result: { value: string; error?: string }
      try {
        result = await pollForEvalResult(id, 15_000)
      } catch (err: any) {
        results.push({ expression: expr, error: err.message })
        // Stop on timeout — subsequent expressions would also fail
        break
      }

      if (result.error) {
        results.push({ expression: expr, error: result.error })
      } else {
        results.push({ expression: expr, value: result.value })
      }

      // Delay between expressions (not after the last one)
      if (i < exprs.length - 1 && params.delay_between_ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, params.delay_between_ms))
      }
    }

    // Format output
    const hasErrors = results.some((r) => r.error)
    let output: string

    if (results.length === 1) {
      const r = results[0]
      output = r.error ? `Error: ${r.error}` : r.value ?? "<null>"
    } else {
      output = results
        .map((r, i) => {
          const status = r.error ? `Error: ${r.error}` : (r.value ?? "<null>")
          return `[${i + 1}] ${r.expression}\n→ ${status}`
        })
        .join("\n\n")
    }

    return {
      title: hasErrors ? "Sim completed with errors" : "Sim result",
      metadata: { expressions: exprs },
      output,
    }
  },
}, { testOnly: true })
