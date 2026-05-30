import { afterEach, describe, expect, it } from "bun:test"

import { serve } from "bun"

import { ProcessManager, type ProcessSettings } from "./processManager"

function settingsFor(overrides: Partial<ProcessSettings>): () => ProcessSettings {
  return () => ({ mode: "managed", port: 8091, externalUrl: "http://localhost:8080", ...overrides })
}

function makeOutputChannel() {
  return { appendLine() {}, append() {}, show() {}, dispose() {} }
}

// binaryManager.getBinaryPath is only reached when we spawn our own process.
// Point it at a path that would fail to spawn so any accidental spawn is loud.
function makeBinaryManager() {
  return { getBinaryPath: () => "/nonexistent/butter-should-not-spawn" }
}

function makeConfigManager() {
  return { ensureConfig: async () => "/tmp/butter-test-config.yaml" }
}

function startHealthyServer() {
  return serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/healthz") {
        return new Response("ok", { status: 200 })
      }
      return new Response("Not Found", { status: 404 })
    },
  })
}

let active: { stop: () => void } | null = null

afterEach(() => {
  active?.stop()
  active = null
})

describe("ProcessManager adoption", () => {
  it("adopts an existing healthy instance instead of spawning", async () => {
    const server = startHealthyServer()
    active = server

    const pm = new ProcessManager(
      makeBinaryManager() as never,
      makeConfigManager() as never,
      makeOutputChannel() as never,
      undefined,
      settingsFor({ port: server.port }),
    )

    await pm.start()

    expect(pm.getState()).toBe("running")

    pm.dispose()
  })

  it("does not stop an adopted instance on stop()", async () => {
    let healthHits = 0
    const server = serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/healthz") {
          healthHits++
          return new Response("ok", { status: 200 })
        }
        return new Response("Not Found", { status: 404 })
      },
    })
    active = server

    const pm = new ProcessManager(
      makeBinaryManager() as never,
      makeConfigManager() as never,
      makeOutputChannel() as never,
      undefined,
      settingsFor({ port: server.port }),
    )

    await pm.start()
    expect(pm.getState()).toBe("running")

    await pm.stop()
    expect(pm.getState()).toBe("stopped")

    // The shared server is still up — adoption never owned it, so stop() must
    // not have killed it. A follow-up health probe still succeeds.
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`)
    expect(res.ok).toBe(true)
    expect(healthHits).toBeGreaterThan(0)

    pm.dispose()
  })

  it("attaches immediately in external mode without probing", async () => {
    const pm = new ProcessManager(
      makeBinaryManager() as never,
      makeConfigManager() as never,
      makeOutputChannel() as never,
      undefined,
      // Unreachable URL — external mode must not probe it to reach "running".
      settingsFor({ mode: "external", externalUrl: "http://localhost:1" }),
    )

    await pm.start()
    expect(pm.getState()).toBe("running")

    pm.dispose()
  })
})
