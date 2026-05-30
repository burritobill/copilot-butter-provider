import { describe, expect, it, mock } from "bun:test"

import { fetchRequestTraces } from "./requestTracesClient"

describe("fetchRequestTraces", () => {
  it("returns mapped entries on success", async () => {
    const fetchMock = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            requests: [
              {
                timestamp: "2026-05-30T00:00:00Z",
                provider: "bedrock",
                model: "claude-sonnet-4-6",
                status_code: 200,
                duration_ms: 42,
                method: "POST",
                path: "/v1/chat/completions",
                streaming: false,
              },
            ],
          }),
      }),
    )

    const oldFetch = globalThis.fetch
    // @ts-expect-error - mocked fetch for test
    globalThis.fetch = fetchMock

    const out = await fetchRequestTraces("http://127.0.0.1:8091", 50)

    globalThis.fetch = oldFetch

    expect(out).not.toBeNull()
    expect(out?.length).toBe(1)
    expect(out?.[0]?.provider).toBe("bedrock")
    expect(out?.[0]?.status).toBe(200)
    expect(out?.[0]?.durationMs).toBe(42)
  })

  it("returns null on non-OK response", async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: false }))
    const oldFetch = globalThis.fetch
    // @ts-expect-error - mocked fetch for test
    globalThis.fetch = fetchMock

    const out = await fetchRequestTraces("http://127.0.0.1:8091", 50)

    globalThis.fetch = oldFetch

    expect(out).toBeNull()
  })

  it("returns null when fetch throws", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("boom")))
    const oldFetch = globalThis.fetch
    // @ts-expect-error - mocked fetch for test
    globalThis.fetch = fetchMock

    const out = await fetchRequestTraces("http://127.0.0.1:8091", 50)

    globalThis.fetch = oldFetch

    expect(out).toBeNull()
  })
})
