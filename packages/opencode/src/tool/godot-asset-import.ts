import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { AssetMetadata } from "../provider/asset/metadata"
import { AssetProvider } from "../provider/asset/asset-provider"

const DESCRIPTION = `Import user-provided asset files into the Godot project with AI metadata tracking.

Import user-provided asset files into the Godot project with AI metadata tracking.

This tool copies external files into the project directory and creates metadata
for tracking asset origin, enabling the AI assistant to understand and manage project assets.

Use this tool when:
- The user wants to import an existing image, model, audio file, or other asset
- You need to bring external resources into the Godot project
- Setting up a project with user-provided reference materials

The tool automatically:
1. Detects the asset type from file extension
2. Copies the file to the specified project destination
3. Creates .ai.{filename}/metadata.json marking it as "imported"
4. Returns the res:// path for use in Godot`

export const GodotAssetImportTool = Tool.define("godot_asset_import", {
  description: DESCRIPTION,
  parameters: z.object({
    source_path: z.string().describe("Absolute path to the file to import"),
    destination: z.string().describe('Project destination path (e.g., "res://assets/characters/")'),
    asset_name: z.string().optional().describe("Override the filename (without extension)"),
    import_settings: z
      .record(z.string(), z.any())
      .optional()
      .describe("Godot import settings override"),
  }),
  async execute(params, ctx) {
    // 1. Validate source file exists and detect type
    const fileInfo = await AssetMetadata.getFileInfo(params.source_path)
    if (!fileInfo.exists) {
      return {
        title: "Import failed",
        metadata: { error: "source_not_found" },
        output: `Error: Source file not found: ${params.source_path}`,
      }
    }

    const assetType = fileInfo.type
    if (!assetType) {
      return {
        title: "Import failed",
        metadata: { error: "unknown_type" },
        output: `Error: Could not detect asset type for extension ".${fileInfo.extension}"`,
      }
    }

    // 2. Resolve destination path
    const projectRoot = Instance.directory
    let destDir = params.destination

    // Convert res:// to absolute path
    if (destDir.startsWith("res://")) {
      destDir = path.join(projectRoot, destDir.slice(6))
    } else if (!path.isAbsolute(destDir)) {
      destDir = path.join(projectRoot, destDir)
    }

    // Ensure destination directory exists
    await fs.mkdir(destDir, { recursive: true })

    // Determine final filename
    const originalName = path.basename(params.source_path)
    const ext = path.extname(originalName)
    const baseName = params.asset_name ?? path.basename(originalName, ext)
    const destPath = path.join(destDir, `${baseName}${ext}`)

    // 3. Ask for permission
    const relPath = path.relative(projectRoot, destPath)
    await ctx.ask({
      permission: "edit",
      patterns: [relPath],
      always: ["*"],
      metadata: {
        action: "import",
        source: params.source_path,
        destination: destPath,
        type: assetType,
      },
    })

    // 4. Copy file to project
    await fs.copyFile(params.source_path, destPath)

    // 5. Write origin metadata
    const metadata: AssetProvider.AssetMetadata = {
      origin: "imported",
      asset_type: assetType,
      imported_from: params.source_path,
      original_filename: originalName,
      created_at: new Date().toISOString(),
      version: 1,
    }
    await AssetMetadata.write(destPath, metadata)

    // 6. Return result with res:// path
    const resPath = `res://${relPath.replace(/\\/g, "/")}`

    return {
      title: `Imported ${baseName}${ext}`,
      metadata: {
        source: params.source_path,
        destination: destPath,
        resPath,
        type: assetType,
        size: fileInfo.size,
      },
      output: `Imported ${assetType} asset to ${resPath}\n\nFile: ${destPath}\nSize: ${formatSize(fileInfo.size)}\nType: ${assetType}`,
    }
  },
})

const BATCH_DESCRIPTION = `Import multiple asset files into the Godot project at once.

Use this tool when:
- The user wants to import multiple files at once
- Setting up a project with a batch of reference materials
- Organizing imported assets into a specific directory`

export const GodotAssetImportBatchTool = Tool.define("godot_asset_import_batch", {
  description: BATCH_DESCRIPTION,
  parameters: z.object({
    files: z
      .array(
        z.object({
          source_path: z.string().describe("Absolute path to the file to import"),
          asset_name: z.string().optional().describe("Override the filename (without extension)"),
        }),
      )
      .describe("List of files to import"),
    destination: z.string().describe('Project destination directory (e.g., "res://assets/imports/")'),
  }),
  async execute(params, ctx) {
    const projectRoot = Instance.directory
    let destDir = params.destination

    // Convert res:// to absolute path
    if (destDir.startsWith("res://")) {
      destDir = path.join(projectRoot, destDir.slice(6))
    } else if (!path.isAbsolute(destDir)) {
      destDir = path.join(projectRoot, destDir)
    }

    // Ensure destination directory exists
    await fs.mkdir(destDir, { recursive: true })

    // Ask for permission for all files
    const relDir = path.relative(projectRoot, destDir)
    await ctx.ask({
      permission: "edit",
      patterns: [`${relDir}/*`],
      always: ["*"],
      metadata: {
        action: "batch_import",
        count: params.files.length,
        destination: destDir,
      },
    })

    // Import each file
    const results: Array<{
      source: string
      destination: string
      resPath: string
      type: AssetProvider.AssetType | undefined
      success: boolean
      error?: string
    }> = []

    for (const file of params.files) {
      const fileInfo = await AssetMetadata.getFileInfo(file.source_path)

      if (!fileInfo.exists) {
        results.push({
          source: file.source_path,
          destination: "",
          resPath: "",
          type: undefined,
          success: false,
          error: "File not found",
        })
        continue
      }

      const originalName = path.basename(file.source_path)
      const ext = path.extname(originalName)
      const baseName = file.asset_name ?? path.basename(originalName, ext)
      const destPath = path.join(destDir, `${baseName}${ext}`)
      const relPath = path.relative(projectRoot, destPath)
      const resPath = `res://${relPath.replace(/\\/g, "/")}`

      try {
        await fs.copyFile(file.source_path, destPath)

        const metadata: AssetProvider.AssetMetadata = {
          origin: "imported",
          asset_type: fileInfo.type!,
          imported_from: file.source_path,
          original_filename: originalName,
          created_at: new Date().toISOString(),
          version: 1,
        }
        await AssetMetadata.write(destPath, metadata)

        results.push({
          source: file.source_path,
          destination: destPath,
          resPath,
          type: fileInfo.type,
          success: true,
        })
      } catch (e) {
        results.push({
          source: file.source_path,
          destination: destPath,
          resPath,
          type: fileInfo.type,
          success: false,
          error: String(e),
        })
      }
    }

    const successful = results.filter((r) => r.success)
    const failed = results.filter((r) => !r.success)

    let output = `Imported ${successful.length}/${params.files.length} file(s) to ${params.destination}\n\n`

    if (successful.length > 0) {
      output += "Imported:\n"
      for (const r of successful) {
        output += `  ✓ ${r.resPath} (${r.type})\n`
      }
    }

    if (failed.length > 0) {
      output += "\nFailed:\n"
      for (const r of failed) {
        output += `  ✗ ${path.basename(r.source)}: ${r.error}\n`
      }
    }

    return {
      title: `Imported ${successful.length} file(s)`,
      metadata: {
        destination: destDir,
        total: params.files.length,
        successful: successful.length,
        failed: failed.length,
        results,
      },
      output,
    }
  },
})

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
