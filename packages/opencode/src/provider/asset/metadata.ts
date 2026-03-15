import path from "path"
import fs from "fs/promises"
import { AssetProvider } from "./asset-provider"

/**
 * Asset metadata utilities for reading/writing AI metadata.
 *
 * All metadata is stored in `.ai.{filename}/metadata.json` (version dir).
 *   - res://assets/knight.png → res://assets/.ai.knight.png/metadata.json
 */
export namespace AssetMetadata {
  /** Read metadata from version dir metadata.json */
  export async function read(assetPath: string): Promise<AssetProvider.AssetMetadata | undefined> {
    const verIndex = getVersionIndexPath(assetPath)
    try {
      const content = await fs.readFile(verIndex, "utf-8")
      return AssetProvider.AssetMetadata.parse(JSON.parse(content))
    } catch {
      return undefined
    }
  }

  /** Write metadata to version dir metadata.json (preserves version index fields) */
  export async function write(assetPath: string, metadata: AssetProvider.AssetMetadata): Promise<void> {
    const verDir = getVersionDir(assetPath)
    await fs.mkdir(verDir, { recursive: true })
    const verIndex = getVersionIndexPath(assetPath)

    // Preserve version index fields (history, current_version) from existing metadata
    let existing: Record<string, any> = {}
    try {
      existing = JSON.parse(await fs.readFile(verIndex, "utf-8"))
    } catch {
      // No existing file
    }
    const merged: Record<string, any> = { ...metadata }
    if (existing.history) merged.history = existing.history
    if (existing.current_version != null) merged.current_version = existing.current_version

    const content = JSON.stringify(merged, null, 2)
    await fs.writeFile(verIndex, content, "utf-8")
  }

  /** Update metadata (merge with existing) */
  export async function update(
    assetPath: string,
    updates: Partial<AssetProvider.AssetMetadata>,
  ): Promise<AssetProvider.AssetMetadata> {
    const existing = await read(assetPath)
    const merged = { ...existing, ...updates } as AssetProvider.AssetMetadata

    // Increment version if prompt or model changed
    if (
      existing &&
      (updates.prompt !== existing.prompt || updates.model !== existing.model)
    ) {
      merged.version = (existing.version ?? 1) + 1

      // Add to version history
      merged.version_history = merged.version_history ?? []
      merged.version_history.push({
        version: existing.version ?? 1,
        prompt: existing.prompt,
        model: existing.model,
        seed: existing.seed,
        timestamp: new Date().toISOString(),
        file: getVersionFilePath(assetPath, existing.version ?? 1),
      })
    }

    await write(assetPath, merged)
    return merged
  }

  /** Delete all AI metadata (entire .ai.{filename}/ directory) */
  export async function remove(assetPath: string): Promise<void> {
    const verDir = getVersionDir(assetPath)
    try {
      await fs.rm(verDir, { recursive: true, force: true })
    } catch {
      // Ignore if doesn't exist
    }
  }

  /**
   * Scan a directory (recursively) and remove .ai.{filename}/ metadata dirs
   * whose source asset file no longer exists.
   * Returns the list of cleaned paths.
   */
  export async function cleanOrphaned(rootDir: string): Promise<string[]> {
    const cleaned: string[] = []
    await _cleanDir(rootDir, cleaned)
    return cleaned
  }

  async function _cleanDir(dir: string, cleaned: string[]): Promise<void> {
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".ai.")) {
          // .ai.{filename} → check if {filename} exists in same dir
          const assetName = entry.name.slice(4) // strip ".ai."
          const assetPath = path.join(dir, assetName)
          try {
            await fs.access(assetPath)
          } catch {
            // Asset gone — remove orphaned metadata
            await fs.rm(fullPath, { recursive: true, force: true })
            cleaned.push(assetPath)
          }
        } else {
          // Recurse into non-metadata directories
          await _cleanDir(fullPath, cleaned)
        }
      }
    }
  }

  // ── Version History (.ai.{filename}/ folder) ────────────────────────

  /** Get hidden version dir: dir/.ai.filename/ */
  export function getVersionDir(assetPath: string): string {
    const dir = path.dirname(assetPath)
    const file = path.basename(assetPath)
    return path.join(dir, `.ai.${file}`)
  }

  /** Get version asset path: dir/.ai.filename/vN.ext */
  export function getVersionFilePath(assetPath: string, version: number): string {
    const ext = path.extname(assetPath)
    return path.join(getVersionDir(assetPath), `v${version}${ext}`)
  }

  /** Get version metadata path: dir/.ai.filename/vN.json */
  export function getVersionMetaPath(assetPath: string, version: number): string {
    return path.join(getVersionDir(assetPath), `v${version}.json`)
  }

  /** Get version index path: dir/.ai.filename/metadata.json */
  export function getVersionIndexPath(assetPath: string): string {
    return path.join(getVersionDir(assetPath), "metadata.json")
  }

  /** Read version index (metadata.json) */
  export async function readVersionIndex(assetPath: string): Promise<Record<string, any> | undefined> {
    try {
      const content = await fs.readFile(getVersionIndexPath(assetPath), "utf-8")
      return JSON.parse(content)
    } catch {
      return undefined
    }
  }

  /** Write version index (metadata.json) */
  export async function writeVersionIndex(assetPath: string, data: Record<string, any>): Promise<void> {
    await fs.writeFile(getVersionIndexPath(assetPath), JSON.stringify(data, null, 2), "utf-8")
  }

  /** Save current asset as a versioned snapshot. Idempotent. */
  export async function saveVersion(assetPath: string): Promise<void> {
    const meta = await read(assetPath)
    if (!meta) return

    const version = meta.version ?? 1
    const verDir = getVersionDir(assetPath)
    const verFile = getVersionFilePath(assetPath, version)

    // Already saved — skip.
    try {
      await fs.access(verFile)
      return
    } catch {
      // Not saved yet, continue.
    }

    // Ensure dir exists.
    await fs.mkdir(verDir, { recursive: true })

    // Copy asset binary.
    await fs.copyFile(assetPath, verFile)

    // Write per-version metadata.
    const verMeta = {
      version,
      prompt: meta.prompt ?? "",
      negative_prompt: meta.negative_prompt ?? "",
      provider: meta.provider ?? "",
      model: meta.model ?? "",
      seed: meta.seed ?? -1,
      timestamp: meta.generated_at ?? new Date().toISOString(),
    }
    await fs.writeFile(getVersionMetaPath(assetPath, version), JSON.stringify(verMeta, null, 2), "utf-8")

    // Update version index.
    const index = (await readVersionIndex(assetPath)) ?? {}
    index.origin = meta.origin ?? "unknown"
    index.provider = meta.provider ?? ""
    index.current_version = version
    const history: number[] = index.history ?? []
    if (!history.includes(version)) {
      history.push(version)
    }
    index.history = history
    await writeVersionIndex(assetPath, index)
  }

  /** Switch active asset to a specific version. Saves current first. */
  export async function useVersion(assetPath: string, version: number): Promise<void> {
    const verFile = getVersionFilePath(assetPath, version)
    await fs.access(verFile) // throws if missing

    await saveVersion(assetPath)
    await fs.copyFile(verFile, assetPath)

    // Apply version metadata to sidecar.
    const verMetaPath = getVersionMetaPath(assetPath, version)
    try {
      const verMetaContent = await fs.readFile(verMetaPath, "utf-8")
      const verMeta = JSON.parse(verMetaContent)
      const meta = await read(assetPath)
      if (meta) {
        meta.prompt = verMeta.prompt ?? meta.prompt
        meta.negative_prompt = verMeta.negative_prompt ?? meta.negative_prompt
        meta.model = verMeta.model ?? meta.model
        meta.seed = verMeta.seed ?? meta.seed
        meta.version = version
        await write(assetPath, meta)
      }
    } catch { /* version meta missing, just copy the file */ }

    // Update index.
    const index = (await readVersionIndex(assetPath)) ?? {}
    index.current_version = version
    await writeVersionIndex(assetPath, index)
  }

  /** Delete a version (cannot delete current). */
  export async function deleteVersion(assetPath: string, version: number): Promise<void> {
    const index = (await readVersionIndex(assetPath)) ?? {}
    if (index.current_version === version) {
      throw new Error("Cannot delete the current version")
    }

    try { await fs.unlink(getVersionFilePath(assetPath, version)) } catch {}
    try { await fs.unlink(getVersionMetaPath(assetPath, version)) } catch {}

    if (index.history) {
      index.history = (index.history as number[]).filter((v: number) => v !== version)
      await writeVersionIndex(assetPath, index)
    }
  }

  /** List all versions with their metadata. */
  export async function listVersions(assetPath: string): Promise<Array<{
    version: number
    prompt: string
    model: string
    timestamp: string
    is_current: boolean
    file_exists: boolean
  }>> {
    const index = await readVersionIndex(assetPath)
    if (!index?.history) return []

    const current = index.current_version ?? -1
    const results = []

    for (const ver of index.history as number[]) {
      let prompt = "", model = "", timestamp = ""
      try {
        const content = await fs.readFile(getVersionMetaPath(assetPath, ver), "utf-8")
        const meta = JSON.parse(content)
        prompt = meta.prompt ?? ""
        model = meta.model ?? ""
        timestamp = meta.timestamp ?? ""
      } catch {}

      let fileExists = false
      try { await fs.access(getVersionFilePath(assetPath, ver)); fileExists = true } catch {}

      results.push({ version: ver, prompt, model, timestamp, is_current: ver === current, file_exists: fileExists })
    }

    return results
  }

  /** Check if asset has AI metadata */
  export async function exists(assetPath: string): Promise<boolean> {
    try {
      await fs.access(getVersionIndexPath(assetPath))
      return true
    } catch {
      return false
    }
  }

  // ── File Type Detection ──────────────────────────────────────────────

  const EXTENSION_TO_TYPE: Record<string, AssetProvider.AssetType> = {
    // Textures
    png: "texture",
    jpg: "texture",
    jpeg: "texture",
    webp: "texture",
    svg: "sprite",
    bmp: "texture",
    tga: "texture",
    exr: "texture",
    hdr: "cubemap",

    // 3D Models
    glb: "model",
    gltf: "model",
    fbx: "model",
    obj: "model",
    dae: "model",
    blend: "model",

    // Audio
    mp3: "audio_music",
    wav: "audio_sfx",
    ogg: "audio_sfx",
    flac: "audio_music",

    // Shaders
    gdshader: "shader",
    glsl: "shader",

    // Materials
    tres: "material",

    // Scenes
    tscn: "scene",
    scn: "scene",

    // Fonts
    ttf: "font",
    otf: "font",
    woff: "font",
    woff2: "font",
  }

  /** Detect asset type from file extension */
  export function detectType(filePath: string): AssetProvider.AssetType | undefined {
    const ext = path.extname(filePath).toLowerCase().slice(1)
    return EXTENSION_TO_TYPE[ext]
  }

  /** Get file info for import */
  export async function getFileInfo(filePath: string): Promise<{
    exists: boolean
    type: AssetProvider.AssetType | undefined
    size: number
    extension: string
  }> {
    const ext = path.extname(filePath).toLowerCase().slice(1)
    const type = detectType(filePath)

    try {
      const stat = await fs.stat(filePath)
      return {
        exists: true,
        type,
        size: stat.size,
        extension: ext,
      }
    } catch {
      return {
        exists: false,
        type,
        size: 0,
        extension: ext,
      }
    }
  }

  // ── Placeholder Category Detection ───────────────────────────────────

  const CATEGORY_KEYWORDS: Record<AssetProvider.PlaceholderCategory, string[]> = {
    character: ["character", "player", "npc", "enemy", "hero", "villain", "person", "humanoid", "creature"],
    environment: ["environment", "terrain", "ground", "floor", "wall", "tree", "rock", "grass", "water", "sky"],
    ui: ["ui", "hud", "button", "icon", "menu", "interface", "gui", "panel", "window"],
    item: ["item", "weapon", "sword", "gun", "armor", "potion", "key", "chest", "coin", "prop", "object"],
    effect: ["effect", "particle", "explosion", "fire", "smoke", "magic", "sparkle", "glow", "trail"],
    skybox: ["skybox", "sky", "background", "backdrop", "panorama", "hdri"],
    default: [],
  }

  /** Detect placeholder category from prompt text */
  export function detectCategory(prompt: string): AssetProvider.PlaceholderCategory {
    const lower = prompt.toLowerCase()

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (category === "default") continue
      for (const keyword of keywords) {
        if (lower.includes(keyword)) {
          return category as AssetProvider.PlaceholderCategory
        }
      }
    }

    return "default"
  }

  /** Get placeholder color for category */
  export function getCategoryColor(category: AssetProvider.PlaceholderCategory): [number, number, number, number] {
    return AssetProvider.PLACEHOLDER_COLORS[category]
  }
}
