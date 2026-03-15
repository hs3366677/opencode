import { Log } from "./log"

const log = Log.create({ service: "image" })

// 4.5 MB raw bytes — base64 encoding inflates ~33%, keeping well under Anthropic's 5 MB limit
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024

/**
 * Compress a base64-encoded image if it exceeds the API size limit.
 * Returns { data, mime } with possibly re-encoded JPEG data and updated mime type.
 */
export async function compressImageBase64(base64Data: string, mime: string): Promise<{ data: string; mime: string }> {
  const buf = Buffer.from(base64Data, "base64")
  if (buf.length <= MAX_IMAGE_BYTES) return { data: base64Data, mime }

  try {
    const sharp = (await import("sharp")).default
    const meta = await sharp(buf).metadata()
    if (!meta.width || !meta.height) return { data: base64Data, mime }

    for (let scale = 0.75; scale >= 0.15; scale -= 0.1) {
      const w = Math.max(1, Math.round(meta.width * scale))
      const h = Math.max(1, Math.round(meta.height * scale))
      const compressed = await sharp(buf).resize(w, h, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer()
      if (compressed.length <= MAX_IMAGE_BYTES) {
        log.info("image compressed for API", {
          originalKB: Math.round(buf.length / 1024),
          compressedKB: Math.round(compressed.length / 1024),
          scale: Math.round(scale * 100) + "%",
        })
        return { data: compressed.toString("base64"), mime: "image/jpeg" }
      }
    }
    // Last resort
    const tiny = await sharp(buf).resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer()
    log.warn("image heavily compressed", { originalKB: Math.round(buf.length / 1024), compressedKB: Math.round(tiny.length / 1024) })
    return { data: tiny.toString("base64"), mime: "image/jpeg" }
  } catch {
    return { data: base64Data, mime }
  }
}

/**
 * Compress a data URL (data:mime;base64,...) if the image exceeds the API size limit.
 * Returns the (possibly compressed) data URL.
 */
export async function compressDataUrl(dataUrl: string): Promise<{ url: string; mime: string }> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) return { url: dataUrl, mime: "" }

  const [, mime, base64Data] = match
  if (!mime.startsWith("image/")) return { url: dataUrl, mime }

  const result = await compressImageBase64(base64Data, mime)
  return {
    url: `data:${result.mime};base64,${result.data}`,
    mime: result.mime,
  }
}
