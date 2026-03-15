import { readFileSync } from "fs"
import path from "path"
import { Log } from "../util/log"
import { lazy } from "../util/lazy"

const log = Log.create({ service: "model-defaults" })

export interface ModelDefaults {
  /** Default model for Replicate image generation (text-to-image) */
  image_generation: string
  /** Default model for Replicate image transforms (variation/img2img) */
  image_transform: string
  /** Default model for batch image generation (art director route) */
  image_batch: string
  /** Default model for style consistency (new style profiles) */
  style_consistency: string
  /** Default model for art explore tool */
  art_explore: string
  /** Default model for godot_style_set tool */
  style_set: string
  /** Default model for cornerstone generation plan */
  cornerstone: string
  /** Default model for Meshy 3D generation and transforms */
  model_3d: string
  /** Default model for Doubao image generation and transforms */
  image_doubao: string
  /** Default model for sound effect generation */
  audio_sfx: string
  /** Default model for music generation */
  audio_music: string
  /** LLM model ID for UI measurement vision analysis (empty = use session's default LLM) */
  ui_measure_llm: string
  /** Custom API base URL for UI measurement (e.g. Volcengine Ark). When set, calls this API directly instead of the provider system. */
  ui_measure_api_base: string
  /** API key for the custom UI measurement endpoint */
  ui_measure_api_key: string
  /** Model name for the custom UI measurement endpoint */
  ui_measure_model: string
}

const BUILTIN_DEFAULTS: ModelDefaults = {
  image_generation: "nano-banana-2",
  image_transform: "sdxl",
  image_batch: "nano-banana-2",
  style_consistency: "nano-banana-2",
  art_explore: "nano-banana-2",
  style_set: "nano-banana-2",
  cornerstone: "nano-banana-2",
  model_3d: "meshy-6",
  image_doubao: "seedream-4",
  audio_sfx: "suno-sfx",
  audio_music: "suno-v5",
  ui_measure_llm: "",
  ui_measure_api_base: "",
  ui_measure_api_key: "",
  ui_measure_model: "",
}

function findEngineRoot(): string | null {
  let dir = path.resolve(import.meta.dir, "../../..")
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(path.join(dir, "makabaka.json"))
      return dir
    } catch {
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
  return null
}

function loadDefaults(): ModelDefaults {
  const engineRoot = findEngineRoot()
  if (!engineRoot) {
    log.info("engine root not found, using built-in defaults")
    return { ...BUILTIN_DEFAULTS }
  }

  const configPath = path.join(engineRoot, "makabaka-models.json")
  try {
    const raw = readFileSync(configPath, "utf8")
    const parsed = JSON.parse(raw) as Partial<ModelDefaults>
    const merged = { ...BUILTIN_DEFAULTS, ...parsed }
    log.info("loaded model defaults from config", { path: configPath })
    return merged
  } catch {
    log.info("no makabaka-models.json found, using built-in defaults")
    return { ...BUILTIN_DEFAULTS }
  }
}

/** Lazy-loaded model defaults. Reads the config file once on first access. */
export const getModelDefaults = lazy(loadDefaults)
