import fs from "fs/promises"
import { readFileSync } from "fs"
import path from "path"
import { getModelDefaults } from "../../config/model-defaults"

export interface StyleProfile {
  /** res:// path to the reference asset (usually the cornerstone hero) */
  reference_asset: string
  /** Style description — auto-prepended to every generated asset prompt */
  art_direction: string
  /** Replicate model ID to use for consistency generation */
  consistency_model: string
  /** How strongly to follow the reference image (0.0–1.0) */
  consistency_strength: number
  /** Palette HEX values extracted from the chosen style */
  palette: string[]
  created_at: string
}

const PROFILE_FILENAME = ".ai_style_profile.json"

/** Read the project style profile synchronously. Returns null if not found. */
export function readProfile(projectRoot: string): StyleProfile | null {
  try {
    const profilePath = path.join(projectRoot, PROFILE_FILENAME)
    const raw = readFileSync(profilePath, "utf8")
    return JSON.parse(raw) as StyleProfile
  } catch {
    return null
  }
}

/** Write (or overwrite) the project style profile. */
export async function writeProfile(projectRoot: string, profile: StyleProfile): Promise<void> {
  // Sanitize art_direction: must be technique-only, max ~200 chars.
  // If the LLM wrote a full scene description, truncate to the first sentence.
  if (profile.art_direction && profile.art_direction.length > 200) {
    const firstSentence = profile.art_direction.split(". ")[0]
    profile.art_direction = firstSentence.length > 200
      ? firstSentence.slice(0, 200)
      : firstSentence
  }
  const profilePath = path.join(projectRoot, PROFILE_FILENAME)
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), "utf8")
}

/** Default values for a new StyleProfile */
export function defaultProfile(): Partial<StyleProfile> {
  return {
    consistency_model: getModelDefaults().style_consistency,
    consistency_strength: 0.7,
    palette: [],
    created_at: new Date().toISOString(),
  }
}
