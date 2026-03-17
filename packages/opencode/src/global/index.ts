import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"

const app = "redblue"

// On Windows, use %LOCALAPPDATA% (e.g. C:\Users\X\AppData\Local\redblue\)
// instead of ~/.local/share which is a Unix convention.
const localAppData = process.platform === "win32" ? process.env.LOCALAPPDATA : undefined
const winBase = localAppData ? path.join(localAppData, app) : undefined

const data = winBase ? path.join(winBase, "data") : path.join(xdgData!, app)
const cache = winBase ? path.join(winBase, "cache") : path.join(xdgCache!, app)
const config = winBase ? path.join(winBase, "config") : path.join(xdgConfig!, app)
const state = winBase ? path.join(winBase, "state") : path.join(xdgState!, app)

export namespace Global {
  export const Path = {
    // Allow override via OPENCODE_TEST_HOME for test isolation
    get home() {
      return process.env.OPENCODE_TEST_HOME || os.homedir()
    },
    data,
    bin: path.join(data, "bin"),
    log: path.join(data, "log"),
    cache,
    config,
    state,
  }
}

await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])

const CACHE_VERSION = "19"

const version = await Bun.file(path.join(Global.Path.cache, "version"))
  .text()
  .catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Bun.file(path.join(Global.Path.cache, "version")).write(CACHE_VERSION)
}
