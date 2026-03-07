import { Log } from "../../util/log"
import path from "path"
import fs from "fs/promises"

const log = Log.create({ service: "asset.atlas-splitter" })

export namespace AtlasSplitter {
  /** A single detected UI element region within an atlas image */
  export interface DetectedRegion {
    /** Sequential index (0-based), sorted top-left to bottom-right */
    index: number
    /** Bounding rectangle in the atlas image */
    rect: { x: number; y: number; width: number; height: number }
    /** Pixel area of the detected contour */
    area: number
    /** Cropped image buffer (PNG) */
    buffer: Buffer
    /** Optional label assigned by the caller */
    label?: string
  }

  export interface SplitOptions {
    /** Minimum area in pixels to keep a region (filters noise). Default: 100 */
    minArea?: number
    /** Morphological dilation kernel size (merges nearby pixels). Default: 5 */
    dilationKernel?: number
    /** Number of dilation iterations. Default: 2 */
    dilationIterations?: number
    /** Padding in pixels around each detected region. Default: 2 */
    padding?: number
    /** Background color detection mode. Default: "alpha" */
    bgMode?: "alpha" | "white" | "black"
  }

  /**
   * Detect and split connected regions from an atlas image.
   *
   * OpenCV WASM compilation is synchronous and blocks the event loop,
   * so we run the detection in a subprocess to avoid freezing the server.
   */
  export async function split(imageBuffer: Buffer, options?: SplitOptions): Promise<DetectedRegion[]> {
    const minArea = options?.minArea ?? 100
    const kernelSize = options?.dilationKernel ?? 5
    const iterations = options?.dilationIterations ?? 2
    const padding = options?.padding ?? 2
    const bgMode = options?.bgMode ?? "alpha"

    // Write worker script to the opencode package directory (not system temp)
    // so that Bun's require() can resolve node_modules from __dirname
    const pkgDir = path.resolve(import.meta.dir, "../../..")
    const tmpSubDir = path.join(pkgDir, ".atlas-tmp")
    await fs.mkdir(tmpSubDir, { recursive: true })
    const tmpId = `atlas-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const tmpImagePath = path.join(tmpSubDir, `${tmpId}-input.png`)
    const tmpResultPath = path.join(tmpSubDir, `${tmpId}-result.json`)
    const tmpScriptPath = path.join(tmpSubDir, `${tmpId}-worker.cjs`)

    await fs.writeFile(tmpImagePath, imageBuffer)

    // Build and write the subprocess script to a file (not inline -e)
    // This ensures __dirname is properly set for opencv-js WASM resolution
    const script = buildWorkerScript({
      imagePath: tmpImagePath,
      resultPath: tmpResultPath,
      minArea,
      kernelSize,
      iterations,
      padding,
      bgMode,
    })
    await fs.writeFile(tmpScriptPath, script, "utf-8")

    log.info("spawning atlas split subprocess", { tmpId })

    try {
      // Run OpenCV detection in a Node.js subprocess (not Bun — opencv-js WASM hangs in Bun).
      // The .cjs worker script lives under the opencode package dir so require() resolves
      // sharp and @techstark/opencv-js via __dirname → node_modules.
      const proc = Bun.spawn(["node", tmpScriptPath], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })

      const exitCode = await proc.exited
      const stderr = await new Response(proc.stderr).text()

      if (exitCode !== 0) {
        log.error("atlas split subprocess failed", { exitCode, stderr: stderr.slice(0, 1000) })
        throw new Error(`Atlas split failed (exit ${exitCode}): ${stderr.slice(0, 500)}`)
      }

      // Read detection results
      const resultJson = await fs.readFile(tmpResultPath, "utf-8")
      const rects: { rect: { x: number; y: number; width: number; height: number }; area: number }[] =
        JSON.parse(resultJson)

      log.info("subprocess detected regions", { count: rects.length })

      // Crop each region using sharp (sharp is async-safe, no blocking)
      const sharp = (await import("sharp")).default
      const regions: DetectedRegion[] = []

      const meta = await sharp(imageBuffer).metadata()
      const imgW = meta.width!
      const imgH = meta.height!

      for (let i = 0; i < rects.length; i++) {
        const { rect, area } = rects[i]

        // Apply padding, clamped to image bounds
        const x = Math.max(0, rect.x - padding)
        const y = Math.max(0, rect.y - padding)
        const w = Math.min(imgW - x, rect.width + padding * 2)
        const h = Math.min(imgH - y, rect.height + padding * 2)

        const cropped = await sharp(imageBuffer)
          .ensureAlpha()
          .extract({ left: x, top: y, width: w, height: h })
          .png()
          .toBuffer()

        regions.push({
          index: i,
          rect: { x, y, width: w, height: h },
          area,
          buffer: cropped,
        })
      }

      log.info("atlas split complete", { elementCount: regions.length })
      return regions
    } finally {
      // Cleanup temp files
      await fs.unlink(tmpImagePath).catch(() => {})
      await fs.unlink(tmpResultPath).catch(() => {})
      await fs.unlink(tmpScriptPath).catch(() => {})
    }
  }

  /**
   * Build the inline script that runs in a subprocess.
   * This script loads OpenCV, detects contours, and writes results to a JSON file.
   */
  function buildWorkerScript(opts: {
    imagePath: string
    resultPath: string
    minArea: number
    kernelSize: number
    iterations: number
    padding: number
    bgMode: string
  }): string {
    // Escape backslashes in Windows paths for the inline script
    const imgPath = opts.imagePath.replace(/\\/g, "\\\\")
    const resPath = opts.resultPath.replace(/\\/g, "\\\\")

    return `
const sharp = require("sharp");
const fs = require("fs");
const cv = require("@techstark/opencv-js");

// opencv-js WASM init: must use onRuntimeInitialized callback (await hangs)
cv.onRuntimeInitialized = async () => {
  try {
    const imageBuffer = fs.readFileSync("${imgPath}");
    const { data: rawPixels, info } = await sharp(imageBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;

    const src = new cv.Mat(height, width, cv.CV_8UC4);
    src.data.set(rawPixels);

    const gray = new cv.Mat();
    const binary = new cv.Mat();
    const dilated = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    try {
      const bgMode = "${opts.bgMode}";
      if (bgMode === "alpha") {
        const chVec = new cv.MatVector();
        cv.split(src, chVec);
        const alpha = chVec.get(3);
        cv.threshold(alpha, binary, 10, 255, cv.THRESH_BINARY);
        alpha.delete();
        chVec.delete();
      } else if (bgMode === "white") {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.threshold(gray, binary, 240, 255, cv.THRESH_BINARY_INV);
      } else {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.threshold(gray, binary, 15, 255, cv.THRESH_BINARY);
      }

      const kernelSize = ${opts.kernelSize};
      const iterations = ${opts.iterations};
      if (iterations > 0) {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelSize, kernelSize));
        cv.dilate(binary, dilated, kernel, new cv.Point(-1, -1), iterations);
        kernel.delete();
      } else {
        binary.copyTo(dilated);
      }

      cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const minArea = ${opts.minArea};
      const rects = [];
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area < minArea) continue;
        const r = cv.boundingRect(contour);
        rects.push({ rect: { x: r.x, y: r.y, width: r.width, height: r.height }, area });
      }

      // Sort by position
      const medianH = rects.length > 0
        ? rects.map(r => r.rect.height).sort((a, b) => a - b)[Math.floor(rects.length / 2)]
        : 0;
      const rowTol = medianH * 0.3;
      rects.sort((a, b) => {
        if (Math.abs(a.rect.y - b.rect.y) <= rowTol) return a.rect.x - b.rect.x;
        return a.rect.y - b.rect.y;
      });

      fs.writeFileSync("${resPath}", JSON.stringify(rects));
    } finally {
      src.delete(); gray.delete(); binary.delete();
      dilated.delete(); contours.delete(); hierarchy.delete();
    }
  } catch (e) {
    console.error(e.stack || e.message || String(e));
    process.exit(1);
  }
};
`
  }

  /**
   * Generate Godot AtlasTexture .tres file content for a detected region.
   */
  export function generateAtlasTres(atlasResPath: string, region: DetectedRegion): string {
    const { x, y, width, height } = region.rect
    return `[gd_resource type="AtlasTexture" load_steps=2 format=3]

[ext_resource type="Texture2D" path="${atlasResPath}" id="1"]

[resource]
atlas = ExtResource("1")
region = Rect2(${x}, ${y}, ${width}, ${height})
margin = Rect2(0, 0, 0, 0)
`
  }
}
