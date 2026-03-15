// Minimal entry point for packaged Makabaka Engine.
// Bypasses yargs/y18n to avoid Bun single-exe virtual filesystem crash.
// Usage: opencode-serve.exe [--port PORT] [--hostname HOST]

import { Server } from "./server/server"

function parseArgs() {
  const args = process.argv.slice(2)
  let port = 4096
  let hostname = "127.0.0.1"

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1])
      i++
    } else if (args[i] === "--hostname" && args[i + 1]) {
      hostname = args[i + 1]
      i++
    } else if (args[i] === "serve") {
      // Skip "serve" subcommand for backwards compatibility
    }
  }

  // Also check PORT env var
  if (process.env.PORT) {
    port = parseInt(process.env.PORT)
  }

  return { port, hostname }
}

const opts = parseArgs()
const server = Server.listen({ ...opts, mdns: false, cors: [] })
console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

// Keep process alive
await new Promise(() => {})
