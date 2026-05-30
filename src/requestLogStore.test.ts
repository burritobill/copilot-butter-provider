import { describe, expect, it, mock } from "bun:test"

void mock.module("vscode", () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} })
    fire() {}
    dispose() {}
  },
}))

const { RequestLogStore } = await import("./requestLogStore")

function traceLine(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ time: "2026-05-29T10:00:00Z", level: "INFO", msg: "request trace", ...fields })}\n`
}

describe("RequestLogStore", () => {
  it("parses request trace lines into entries", () => {
    const store = new RequestLogStore()
    store.ingestChunk(
      traceLine({ provider: "bedrock", model: "claude-haiku", status: 200, duration_ms: 42 }),
    )

    const entries = store.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      provider: "bedrock",
      model: "claude-haiku",
      status: 200,
      durationMs: 42,
    })
  })

  it("ignores non-JSON and non-trace lines", () => {
    const store = new RequestLogStore()
    store.ingestChunk("Starting Butter: /path -config foo\n")
    store.ingestChunk(`${JSON.stringify({ msg: "server started", port: 8091 })}\n`)
    expect(store.size).toBe(0)
  })

  it("buffers partial lines across chunks", () => {
    const store = new RequestLogStore()
    const line = traceLine({ provider: "bedrock", model: "m", status: 200, duration_ms: 1 })
    const mid = Math.floor(line.length / 2)

    store.ingestChunk(line.slice(0, mid)) // no newline yet
    expect(store.size).toBe(0)
    store.ingestChunk(line.slice(mid)) // completes the line
    expect(store.size).toBe(1)
  })

  it("captures error and optional fields", () => {
    const store = new RequestLogStore()
    store.ingestChunk(
      traceLine({
        provider: "bedrock",
        model: "m",
        status: 500,
        duration_ms: 10,
        request_id: "abc",
        streaming: true,
        error: "boom",
      }),
    )
    const e = store.getEntries()[0]!
    expect(e.error).toBe("boom")
    expect(e.requestId).toBe("abc")
    expect(e.streaming).toBe(true)
  })

  it("returns entries most-recent-first and respects the limit", () => {
    const store = new RequestLogStore()
    for (let i = 0; i < 5; i++) {
      store.ingestChunk(traceLine({ provider: "p", model: `m${i}`, status: 200, duration_ms: i }))
    }
    const recent = store.getEntries(2)
    expect(recent).toHaveLength(2)
    expect(recent[0]!.model).toBe("m4")
    expect(recent[1]!.model).toBe("m3")
  })

  it("evicts oldest entries past capacity", () => {
    const store = new RequestLogStore(3)
    for (let i = 0; i < 5; i++) {
      store.ingestChunk(traceLine({ provider: "p", model: `m${i}`, status: 200, duration_ms: i }))
    }
    expect(store.size).toBe(3)
    const models = store.getEntries().map((e) => e.model)
    expect(models).toEqual(["m4", "m3", "m2"])
  })

  it("clears entries", () => {
    const store = new RequestLogStore()
    store.ingestChunk(traceLine({ provider: "p", model: "m", status: 200, duration_ms: 1 }))
    expect(store.size).toBe(1)
    store.clear()
    expect(store.size).toBe(0)
  })
})
