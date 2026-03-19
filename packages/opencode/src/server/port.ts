// Single source of truth for the default server port.
// Reads from BLURED_AI_PORT env var, falls back to 13700.
// Uses a high port to avoid Windows Hyper-V dynamic port exclusion ranges
// which typically affect ports in the 1024-10000 range.
export const DEFAULT_PORT = parseInt(process.env.BLURED_AI_PORT ?? "13700", 10)
