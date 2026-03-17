import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { Auth } from "../../auth"
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { AssetProviderRegistry } from "../../provider/asset"
import capabilitiesJson from "./provider_capabilities.json"

// Provider capability definitions
// Each provider has: display name, services it offers, and optional API validation info
export interface ProviderCapability {
  name: string
  services: ("chat" | "image-generation" | "background-removal" | "3d-generation" | "music-generation" | "atlas-split" | "image-postprocess" | "gif-recording")[]
  api?: { url: string; authType?: "anthropic" | "bearer" | "query" }
  keyPrefix?: string // Expected key prefix for display hint (e.g. "r8_", "sk-")
  local?: boolean // True for local services (no API key needed, use health check instead)
  healthCheck?: string // URL path for health check (e.g. "/ai-assets/rmbg-health")
}

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapability> = capabilitiesJson as Record<string, ProviderCapability>

async function validateProviderKey(providerID: string, apiKey: string): Promise<boolean> {
  const cap = PROVIDER_CAPABILITIES[providerID]
  if (!cap?.api) {
    // No API URL to validate against — cannot verify
    return false
  }

  const baseUrl = cap.api.url.replace(/\/+$/, "")

  // Build headers based on auth type
  const headers: Record<string, string> =
    cap.api.authType === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : cap.api.authType === "query"
        ? {}
        : { Authorization: `Bearer ${apiKey}` }

  let modelsUrl = `${baseUrl}/models`
  if (cap.api.authType === "query") {
    modelsUrl += `?key=${apiKey}`
  }

  try {
    const resp = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000),
    })
    return resp.status >= 200 && resp.status < 400
  } catch {
    return false
  }
}

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: ModelsDev.Provider.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const connected = await Provider.list()

        // Build connected set: LLM providers + all providers with keys in auth.json
        const connectedKeys = new Set(Object.keys(connected))
        const allAuth = await Auth.all()
        for (const providerID of Object.keys(allAuth)) {
          connectedKeys.add(providerID)
        }

        return c.json({
          all: Object.values(connected),
          default: mapValues(connected, (item) => Provider.sort(Object.values(item.models))[0].id),
          connected: [...connectedKeys],
          capabilities: PROVIDER_CAPABILITIES,
        })
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ProviderAuth.methods())
      },
    )
    .post(
      "/:providerID/api-key",
      describeRoute({
        summary: "Set API key",
        description: "Set an API key for a specific AI provider.",
        operationId: "provider.apiKey",
        responses: {
          200: {
            description: "API key saved",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          apiKey: z.string().meta({ description: "API key" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { apiKey } = c.req.valid("json")

        const cap = PROVIDER_CAPABILITIES[providerID]
        const hasChat = cap?.services.includes("chat")

        // Non-chat providers (image gen, 3D, music, etc.) — save key without LLM validation
        if (cap && !hasChat) {
          await ProviderAuth.api({ providerID, key: apiKey })
          // Also register in asset provider registry so it's available immediately
          await AssetProviderRegistry.configureProvider(providerID, apiKey).catch(() => {})
          return c.json(true)
        }

        // Anthropic OAuth tokens (sk-ant-oat01-) are validated by the auth plugin, skip HTTP check
        const isOauthToken = apiKey.startsWith("sk-ant-oat01-")
        if (!isOauthToken) {
          const valid = await validateProviderKey(providerID, apiKey)
          if (!valid) {
            return c.json({ error: "Invalid API key - verification failed" }, 401)
          }
        }

        await ProviderAuth.api({ providerID, key: apiKey })
        Provider.reset()
        return c.json(true)
      },
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method } = c.req.valid("json")
        const result = await ProviderAuth.authorize({
          providerID,
          method,
        })
        return c.json(result)
      },
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, code } = c.req.valid("json")
        await ProviderAuth.callback({
          providerID,
          method,
          code,
        })
        return c.json(true)
      },
    ),
)
