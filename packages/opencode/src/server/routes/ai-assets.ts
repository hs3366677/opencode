import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { generateText } from "ai"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"
import { AssetProviderRegistry } from "../../provider/asset"
import { AssetProvider } from "../../provider/asset/asset-provider"
import { AssetMetadata } from "../../provider/asset/metadata"
import { Provider } from "../../provider/provider"
import { Instance } from "../../project/instance"
import path from "path"
import fs from "fs/promises"

const log = Log.create({ service: "ai-assets" })

// ── Service settings (removebg method, etc.) ────────────────────────────
// Stored in opencode.json under "services" key.

import { Config } from "../../config/config"

export async function getImageModel(): Promise<string> {
  const config = await Config.get()
  return config.services?.image_model ?? "nano-banana-2"
}

export async function getRemoveBgMethod(): Promise<"replicate" | "local"> {
  const config = await Config.get()
  const method = config.services?.removebg_method
  // Migrate old "api" value to "replicate"
  if (method === "api" as any) return "replicate"
  return method ?? "local"
}

export const AIAssetRoutes = lazy(() =>
  new Hono()
    // ── Provider & Model Discovery ─────────────────────────────────────

    .get(
      "/providers",
      describeRoute({
        summary: "List asset providers",
        description: "Get all registered asset generation providers and their capabilities.",
        operationId: "ai-assets.providers.list",
        responses: {
          200: {
            description: "List of asset providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      id: z.string(),
                      name: z.string(),
                      supportedTypes: z.array(AssetProvider.AssetType),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const providers = AssetProviderRegistry.list()
        return c.json(
          providers.map((p) => ({
            id: p.id,
            name: p.name,
            supportedTypes: p.supportedTypes,
          })),
        )
      },
    )

    .get(
      "/providers/status",
      describeRoute({
        summary: "Asset provider status",
        description: "Get status of all configured asset generation providers.",
        operationId: "ai-assets.providers.status",
        responses: {
          200: {
            description: "Provider status list",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      id: z.string(),
                      name: z.string(),
                      supportedTypes: z.array(AssetProvider.AssetType),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(AssetProviderRegistry.status())
      },
    )

    .post(
      "/providers/configure",
      describeRoute({
        summary: "Configure asset provider",
        description: "Configure an asset generation provider at runtime with an API key.",
        operationId: "ai-assets.providers.configure",
        responses: {
          200: {
            description: "Configuration result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    error: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          providerId: z.string(),
          apiKey: z.string(),
          apiUrl: z.string().optional(),
        }),
      ),
      async (c) => {
        const { providerId, apiKey, apiUrl } = c.req.valid("json" as never) as {
          providerId: string
          apiKey: string
          apiUrl?: string
        }
        const result = await AssetProviderRegistry.configureProvider(providerId, apiKey, apiUrl)
        return c.json(result)
      },
    )

    .get(
      "/models",
      describeRoute({
        summary: "List all models",
        description: "Get all available models from all registered providers.",
        operationId: "ai-assets.models.list",
        responses: {
          200: {
            description: "Models grouped by provider",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(AssetProvider.ModelInfo))),
              },
            },
          },
        },
      }),
      async (c) => {
        const models = await AssetProviderRegistry.listAllModels()
        return c.json(models)
      },
    )

    .get(
      "/models/:providerId",
      describeRoute({
        summary: "List provider models",
        description: "Get available models for a specific provider.",
        operationId: "ai-assets.models.byProvider",
        responses: {
          200: {
            description: "List of models",
            content: {
              "application/json": {
                schema: resolver(z.array(AssetProvider.ModelInfo)),
              },
            },
          },
        },
      }),
      validator("param", z.object({ providerId: z.string() })),
      async (c) => {
        const { providerId } = c.req.valid("param" as never) as { providerId: string }
        const models = await AssetProviderRegistry.listModels(providerId)
        return c.json(models)
      },
    )

    // ── Generation ─────────────────────────────────────────────────────

    .post(
      "/generate",
      describeRoute({
        summary: "Generate an asset",
        description: "Start an asset generation job using the configured provider.",
        operationId: "ai-assets.generate",
        responses: {
          200: {
            description: "Generation started",
            content: {
              "application/json": {
                schema: resolver(
                  AssetProvider.GenerationResult.extend({
                    providerId: z.string(),
                    model: z.string(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          type: AssetProvider.AssetType,
          prompt: z.string(),
          negativePrompt: z.string().optional(),
          model: z.string().optional(),
          parameters: z.record(z.string(), z.any()).default({}),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json" as never) as AssetProvider.GenerationRequest
        log.info("[generate] request", { type: body.type, requestedModel: body.model, prompt: body.prompt?.slice(0, 80) })
        let resolved
        try {
          resolved = await AssetProviderRegistry.resolveModel(body.type, body.model)
        } catch (e: any) {
          return c.json({ error: e.message }, 400)
        }
        const { provider, modelId } = resolved
        log.info("[generate] resolved", { provider: provider.id, modelId, requestedModel: body.model })
        let result
        try {
          result = await provider.generate({ ...body, model: modelId })
        } catch (e: any) {
          return c.json({ error: `Generation failed (${provider.id}): ${e.message}` }, 500)
        }
        return c.json({
          generationId: result.generationId,
          status: result.status,
          estimatedTime: result.estimatedTime,
          providerId: provider.id,
          model: modelId,
        })
      },
    )

    // ── Status & Download ──────────────────────────────────────────────

    .get(
      "/status/:providerId/:generationId",
      describeRoute({
        summary: "Check generation status",
        description: "Poll the status of an ongoing asset generation job.",
        operationId: "ai-assets.status",
        responses: {
          200: {
            description: "Current status",
            content: {
              "application/json": {
                schema: resolver(AssetProvider.GenerationStatus),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          providerId: z.string(),
          generationId: z.string(),
        }),
      ),
      async (c) => {
        const { providerId, generationId } = c.req.valid("param" as never) as {
          providerId: string
          generationId: string
        }
        const provider = AssetProviderRegistry.get(providerId)
        if (!provider) {
          return c.json({ error: `Provider not found: ${providerId}` }, 404)
        }
        const status = await provider.checkStatus(generationId)
        return c.json(status)
      },
    )

    .get(
      "/download/:providerId/:generationId",
      describeRoute({
        summary: "Download generated assets",
        description: "Download the completed asset bundle from a generation job.",
        operationId: "ai-assets.download",
        responses: {
          200: {
            description: "Asset bundle metadata (binary files served separately)",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    bundleId: z.string(),
                    assets: z.array(
                      z.object({
                        type: AssetProvider.AssetType,
                        role: z.string(),
                        filename: z.string(),
                        size: z.number(),
                        metadata: z.record(z.string(), z.any()),
                      }),
                    ),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          providerId: z.string(),
          generationId: z.string(),
        }),
      ),
      async (c) => {
        const { providerId, generationId } = c.req.valid("param" as never) as {
          providerId: string
          generationId: string
        }
        const provider = AssetProviderRegistry.get(providerId)
        if (!provider) {
          return c.json({ error: `Provider not found: ${providerId}` }, 404)
        }
        const bundle = await provider.download(generationId)
        return c.json({
          bundleId: bundle.bundleId,
          assets: bundle.assets.map((a) => ({
            type: a.type,
            role: a.role,
            filename: a.filename,
            size: a.data.length,
            metadata: a.metadata,
          })),
        })
      },
    )

    .get(
      "/download/:providerId/:generationId/:filename",
      describeRoute({
        summary: "Download individual asset file",
        description: "Download a specific file from a completed asset bundle.",
        operationId: "ai-assets.download.file",
        responses: {
          200: { description: "Binary asset file" },
        },
      }),
      validator(
        "param",
        z.object({
          providerId: z.string(),
          generationId: z.string(),
          filename: z.string(),
        }),
      ),
      async (c) => {
        const { providerId, generationId, filename } = c.req.valid("param" as never) as {
          providerId: string
          generationId: string
          filename: string
        }
        const provider = AssetProviderRegistry.get(providerId)
        if (!provider) {
          return c.json({ error: `Provider not found: ${providerId}` }, 404)
        }
        const bundle = await provider.download(generationId)
        const asset = bundle.assets.find((a) => a.filename === filename)
        if (!asset) {
          return c.json({ error: `File not found: ${filename}` }, 404)
        }

        const contentType = getContentType(filename)
        return new Response(new Uint8Array(asset.data), {
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Length": String(asset.data.length),
          },
        })
      },
    )

    // ── Transform ──────────────────────────────────────────────────────

    .post(
      "/transform",
      describeRoute({
        summary: "Transform an existing asset",
        description: "Apply an AI transform (upscale, style transfer, etc.) to an existing asset.",
        operationId: "ai-assets.transform",
        responses: {
          200: {
            description: "Transform job started",
            content: {
              "application/json": {
                schema: resolver(
                  AssetProvider.GenerationResult.extend({
                    providerId: z.string(),
                    model: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          sourceType: AssetProvider.AssetType,
          transform: AssetProvider.TransformType,
          prompt: z.string().optional(),
          model: z.string().optional(),
          parameters: z.record(z.string(), z.any()).default({}),
          sourceBase64: z.string().describe("Base64-encoded source file"),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json" as never) as {
          sourceType: AssetProvider.AssetType
          transform: AssetProvider.TransformType
          prompt?: string
          model?: string
          parameters: Record<string, any>
          sourceBase64: string
        }

        const providers = AssetProviderRegistry.findTransformProviders(body.transform)
        if (providers.length === 0) {
          return c.json({ error: `No provider supports transform: ${body.transform}` }, 400)
        }

        const provider = providers[0]
        const result = await provider.transform!({
          sourceFile: Buffer.from(body.sourceBase64, "base64"),
          sourceType: body.sourceType,
          transform: body.transform,
          prompt: body.prompt,
          model: body.model,
          parameters: body.parameters,
        })

        return c.json({
          generationId: result.generationId,
          status: result.status,
          estimatedTime: result.estimatedTime,
          providerId: provider.id,
          model: body.model,
        })
      },
    )

    // ── Supported Types ────────────────────────────────────────────────

    .get(
      "/types",
      describeRoute({
        summary: "List supported asset types",
        description: "Get all asset types supported by currently registered providers.",
        operationId: "ai-assets.types",
        responses: {
          200: {
            description: "Supported types",
            content: {
              "application/json": {
                schema: resolver(z.array(AssetProvider.AssetType)),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(AssetProviderRegistry.supportedTypes())
      },
    )

    // ── Prompt Refinement ──────────────────────────────────────────────

    .post(
      "/refine-prompt",
      describeRoute({
        summary: "Refine an asset generation prompt",
        description:
          "Use an LLM to refine an asset generation prompt based on user instructions.",
        operationId: "ai-assets.refine-prompt",
        responses: {
          200: {
            description: "Refined prompt",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    refinedPrompt: z.string(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          prompt: z.string(),
          instruction: z.string(),
          assetType: z.string().optional(),
        }),
      ),
      async (c) => {
        const { prompt, instruction, assetType } = c.req.valid("json" as never) as {
          prompt: string
          instruction: string
          assetType?: string
        }

        const defaultModel = await Provider.defaultModel()
        const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
        const language = await Provider.getLanguage(model)

        const typeHint = assetType ? ` The asset type is "${assetType}".` : ""

        const result = await generateText({
          model: language,
          messages: [
            {
              role: "system",
              content: `You are an expert at writing prompts for AI asset generation in game development. The user will give you an existing prompt and an instruction for how to refine it. Return ONLY the refined prompt text — no explanations, no quotes, no markdown.${typeHint}`,
            },
            {
              role: "user",
              content: `Current prompt: ${prompt}\n\nInstruction: ${instruction}`,
            },
          ],
          temperature: 0.3,
        })

        return c.json({ refinedPrompt: result.text.trim() })
      },
    )

    // ── Version History ─────────────────────────────────────────────────

    .get("/versions/*", async (c) => {
      const resPath = c.req.path.replace(/^.*\/versions\//, "")
      const assetPath = resolveAssetPath(resPath)
      const versions = await AssetMetadata.listVersions(assetPath)
      const index = await AssetMetadata.readVersionIndex(assetPath)
      return c.json({
        current_version: index?.current_version ?? 0,
        versions,
      })
    })

    .post("/versions/*/use", async (c) => {
      const resPath = c.req.path.replace(/^.*\/versions\//, "").replace(/\/use$/, "")
      const assetPath = resolveAssetPath(resPath)
      const { version } = await c.req.json<{ version: number }>()
      await AssetMetadata.useVersion(assetPath, version)
      return c.json({ success: true, version })
    })

    .delete("/versions/*", async (c) => {
      const resPath = c.req.path.replace(/^.*\/versions\//, "")
      const assetPath = resolveAssetPath(resPath)
      const { version } = await c.req.json<{ version: number }>()
      await AssetMetadata.deleteVersion(assetPath, version)
      return c.json({ success: true, version })
    })

    // Delete metadata for a specific asset
    .delete("/metadata/*", async (c) => {
      const resPath = decodeURIComponent(c.req.path.replace(/^.*\/metadata\//, ""))
      const assetPath = resolveAssetPath(resPath)
      await AssetMetadata.remove(assetPath)
      return c.json({ success: true, path: resPath })
    })

    // Clean orphaned metadata (whose source asset was deleted)
    .post("/metadata/clean", async (c) => {
      const projectRoot = Instance.directory
      const assetsDir = path.join(projectRoot, "assets")
      const cleaned = await AssetMetadata.cleanOrphaned(assetsDir)
      return c.json({ cleaned, count: cleaned.length })
    })

    // GET image generation model config
    .get("/image-model", async (c) => {
      const config = await Config.get()
      const model = config.services?.image_model ?? "nano-banana-2"
      return c.json({ model })
    })

    // POST set image generation model
    .post("/image-model", async (c) => {
      const { model } = await c.req.json<{ model: string }>()
      if (!model) {
        return c.json({ error: "model is required" }, 400)
      }
      await Config.update({ services: { image_model: model } } as any)
      return c.json({ success: true, model })
    })

    // GET removebg method config
    .get("/removebg-method", async (c) => {
      const method = await getRemoveBgMethod()
      return c.json({ method })
    })

    // POST set removebg method config
    .post("/removebg-method", async (c) => {
      const { method } = await c.req.json<{ method: "replicate" | "local" }>()
      if (method !== "replicate" && method !== "local") {
        return c.json({ error: "method must be 'replicate' or 'local'" }, 400)
      }
      await Config.update({ services: { removebg_method: method } } as any)
      return c.json({ success: true, method })
    })

    // Check if local sharp (image postprocessing: trim, resize, crop, pad) is available
    .get("/sharp-health", async (c) => {
      try {
        const pkgDir = path.resolve(import.meta.dir, "../../..")
        const sharpPath = path.join(pkgDir, "node_modules", "sharp")
        const { access } = await import("fs/promises")
        await access(sharpPath)
        return c.json({ status: "ok", detail: "Sharp available" })
      } catch (e: any) {
        return c.json(
          { status: "error", detail: e?.message ?? String(e) },
          503,
        )
      }
    })

    // Check if local gifenc (GIF recording: sharp + gifenc) is available
    .get("/gifenc-health", async (c) => {
      try {
        const pkgDir = path.resolve(import.meta.dir, "../../..")
        const sharpPath = path.join(pkgDir, "node_modules", "sharp")
        const gifencPath = path.join(pkgDir, "node_modules", "gifenc")
        const { access } = await import("fs/promises")
        await access(sharpPath)
        await access(gifencPath)
        return c.json({ status: "ok", detail: "GIF encoder available" })
      } catch (e: any) {
        return c.json(
          { status: "error", detail: e?.message ?? String(e) },
          503,
        )
      }
    })

    // Check if local Atlas Splitter (OpenCV WASM + sharp) is available
    .get("/atlas-split-health", async (c) => {
      try {
        // Atlas splitter uses @techstark/opencv-js (WASM) and sharp in a Node subprocess.
        // Verify the key dependencies can be resolved from the package dir.
        const pkgDir = path.resolve(import.meta.dir, "../../..")
        const opencvPath = path.join(pkgDir, "node_modules", "@techstark", "opencv-js")
        const sharpPath = path.join(pkgDir, "node_modules", "sharp")
        const { access } = await import("fs/promises")
        await access(opencvPath)
        await access(sharpPath)
        return c.json({ status: "ok", detail: "Atlas splitter available" })
      } catch (e: any) {
        return c.json(
          { status: "error", detail: e?.message ?? String(e) },
          503,
        )
      }
    })

    // Check if local RMBG-2.0 service is running
    .get("/rmbg-health", async (c) => {
      const rmbgPort = process.env.MAKABAKA_RMBG_PORT ?? "7860"
      try {
        const resp = await fetch(`http://127.0.0.1:${rmbgPort}/health`, {
          signal: AbortSignal.timeout(5_000),
        })
        if (resp.ok) {
          const data = await resp.json()
          return c.json({ status: "ok", detail: data })
        }
        return c.json({ status: "error", detail: `HTTP ${resp.status}` }, 502)
      } catch (e: any) {
        return c.json(
          { status: "error", detail: e?.message ?? String(e) },
          503,
        )
      }
    })

    // Proxy to local RMBG-2.0 sidecar for background removal
    .post("/remove-background", async (c) => {
      const rmbgPort = process.env.MAKABAKA_RMBG_PORT ?? "7860"
      const body = await c.req.arrayBuffer()
      try {
        const resp = await fetch(`http://127.0.0.1:${rmbgPort}/remove-background`, {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body,
          signal: AbortSignal.timeout(120_000),
        })
        if (!resp.ok) {
          const errText = await resp.text()
          return c.json({ error: "RMBG service error", detail: errText }, 502)
        }
        const resultBuffer = await resp.arrayBuffer()
        return new Response(resultBuffer, {
          headers: { "Content-Type": "image/png" },
        })
      } catch (e: any) {
        return c.json(
          { error: "RMBG service unavailable", detail: e?.message ?? String(e) },
          503,
        )
      }
    }),
)

function resolveAssetPath(resPath: string): string {
  const projectRoot = Instance.directory
  if (resPath.startsWith("res://")) {
    return path.join(projectRoot, resPath.slice(6))
  }
  return path.join(projectRoot, resPath)
}

function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase()
  const types: Record<string, string> = {
    glb: "model/gltf-binary",
    gltf: "model/gltf+json",
    fbx: "application/octet-stream",
    obj: "text/plain",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
  }
  return types[ext ?? ""] ?? "application/octet-stream"
}
