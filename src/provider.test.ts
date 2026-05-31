import { describe, expect, it, mock } from "bun:test"

import { serve } from "bun"

const warningMessages: string[] = []

void mock.module("vscode", () => ({
  window: {
    showWarningMessage: (message: string) => {
      warningMessages.push(message)
      return Promise.resolve(undefined)
    },
  },
  EventEmitter: class {
    event = () => ({ dispose() {} })
    fire() {}
    dispose() {}
  },
  LanguageModelTextPart: class {
    value: string
    constructor(value: string) {
      this.value = value
    }
  },
  LanguageModelToolCallPart: class {
    callId: string
    name: string
    input: object
    constructor(callId: string, name: string, input: object) {
      this.callId = callId
      this.name = name
      this.input = input
    }
  },
  LanguageModelChatToolMode: { Auto: 0, Required: 1 },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
    cancel() {
      this.token.isCancellationRequested = true
    }
    dispose() {}
  },
}))

const { ButterChatModelProvider } = await import("./provider")

function makeOutputChannel() {
  return {
    appendLine() {},
    append() {},
    show() {},
    dispose() {},
  }
}

function makeToken(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose() {} }),
  }
}

describe("ButterChatModelProvider", () => {
  describe("provideLanguageModelChatInformation", () => {
    it("fetches models from a real HTTP server", async () => {
      const server = serve({
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === "/v1/models") {
            return new Response(
              JSON.stringify({
                data: [{ id: "claude-sonnet-4-20250514" }, { id: "claude-3-5-haiku-20241022" }],
              }),
              { headers: { "Content-Type": "application/json" } },
            )
          }
          return new Response("Not Found", { status: 404 })
        },
      })

      try {
        const provider = new ButterChatModelProvider(
          () => `http://localhost:${server.port}`,
          makeOutputChannel() as never,
        )

        const models = await provider.provideLanguageModelChatInformation({}, makeToken() as never)

        expect(models).toHaveLength(2)
        expect(models[0]!.id).toBe("claude-sonnet-4-20250514")
        expect(models[1]!.id).toBe("claude-3-5-haiku-20241022")

        // Check capabilities are populated
        expect(models[0]!.maxInputTokens).toBeGreaterThan(0)

        provider.dispose()
      } finally {
        void server.stop()
      }
    })

    it("falls back to default model when server is unreachable", async () => {
      const provider = new ButterChatModelProvider(
        () => "http://localhost:1", // port 1 — unreachable
        makeOutputChannel() as never,
      )

      const models = await provider.provideLanguageModelChatInformation({}, makeToken() as never)

      // Should return at least 1 default model
      expect(models.length).toBeGreaterThanOrEqual(1)
      expect(models[0]!.id).toBe("claude-sonnet-4-20250514")

      provider.dispose()
    })

    it("restores the full model list from persisted IDs on cold start", async () => {
      const store = new Map<string, unknown>([
        [
          "butter-copilot.knownModelIds",
          ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022", "claude-opus-4-20250514"],
        ],
        ["butter-copilot.lastUsedModel", "claude-3-5-haiku-20241022"],
      ])
      const memento = {
        get: (key: string) => store.get(key),
        update: (key: string, value: unknown) => {
          store.set(key, value)
          return Promise.resolve()
        },
      }

      const provider = new ButterChatModelProvider(
        () => "http://localhost:1", // unreachable — simulates cold start before Butter runs
        makeOutputChannel() as never,
        memento as never,
      )

      const models = await provider.provideLanguageModelChatInformation({}, makeToken() as never)

      expect(models).toHaveLength(3)
      expect(models.map((m) => m.id)).toEqual([
        "claude-sonnet-4-20250514",
        "claude-3-5-haiku-20241022",
        "claude-opus-4-20250514",
      ])
      // Last-used model should be marked as default
      const haiku = models.find((m) => m.id === "claude-3-5-haiku-20241022")
      expect(haiku!.isDefault).toBe(true)

      provider.dispose()
    })

    it("marks the persisted last-used model as default", async () => {
      const server = serve({
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === "/v1/models") {
            return new Response(
              JSON.stringify({
                data: [{ id: "claude-sonnet-4-20250514" }, { id: "claude-3-5-haiku-20241022" }],
              }),
              { headers: { "Content-Type": "application/json" } },
            )
          }
          return new Response("Not Found", { status: 404 })
        },
      })

      try {
        const store = new Map<string, unknown>([
          ["butter-copilot.lastUsedModel", "claude-3-5-haiku-20241022"],
        ])
        const memento = {
          get: (key: string) => store.get(key),
          update: (key: string, value: unknown) => {
            store.set(key, value)
            return Promise.resolve()
          },
        }

        const provider = new ButterChatModelProvider(
          () => `http://localhost:${server.port}`,
          makeOutputChannel() as never,
          memento as never,
        )

        const models = await provider.provideLanguageModelChatInformation({}, makeToken() as never)

        const haiku = models.find((m) => m.id === "claude-3-5-haiku-20241022")
        const sonnet = models.find((m) => m.id === "claude-sonnet-4-20250514")
        expect(haiku!.isDefault).toBe(true)
        expect(sonnet!.isDefault).toBe(false)

        provider.dispose()
      } finally {
        void server.stop()
      }
    })

    it("defaults to the first model when no prior selection is recorded", async () => {
      const server = serve({
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === "/v1/models") {
            return new Response(
              JSON.stringify({
                data: [{ id: "claude-sonnet-4-20250514" }, { id: "claude-3-5-haiku-20241022" }],
              }),
              { headers: { "Content-Type": "application/json" } },
            )
          }
          return new Response("Not Found", { status: 404 })
        },
      })

      try {
        const provider = new ButterChatModelProvider(
          () => `http://localhost:${server.port}`,
          makeOutputChannel() as never,
        )

        const models = await provider.provideLanguageModelChatInformation({}, makeToken() as never)

        expect(models[0]!.isDefault).toBe(true)
        expect(models[1]!.isDefault).toBe(false)

        provider.dispose()
      } finally {
        void server.stop()
      }
    })
  })

  describe("provideLanguageModelChatResponse", () => {
    it("streams a text response from a real HTTP server", async () => {
      const server = serve({
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === "/v1/messages") {
            const events = [
              sseEvent(
                "message_start",
                JSON.stringify({
                  type: "message_start",
                  message: { id: "msg_1", role: "assistant" },
                }),
              ),
              sseEvent(
                "content_block_start",
                JSON.stringify({
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                }),
              ),
              sseEvent(
                "content_block_delta",
                JSON.stringify({
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Hello" },
                }),
              ),
              sseEvent(
                "content_block_delta",
                JSON.stringify({
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: " from" },
                }),
              ),
              sseEvent(
                "content_block_delta",
                JSON.stringify({
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: " Butter!" },
                }),
              ),
              sseEvent(
                "content_block_stop",
                JSON.stringify({ type: "content_block_stop", index: 0 }),
              ),
              sseEvent("message_stop", JSON.stringify({ type: "message_stop" })),
            ]
            return new Response(events.join(""), {
              headers: { "Content-Type": "text/event-stream" },
            })
          }
          return new Response("Not Found", { status: 404 })
        },
      })

      try {
        const provider = new ButterChatModelProvider(
          () => `http://localhost:${server.port}`,
          makeOutputChannel() as never,
        )

        const parts: Array<{ type: string; value?: string }> = []
        const progress = {
          report(part: { value?: string }) {
            if ("value" in part) {
              parts.push({ type: "text", value: part.value })
            }
          },
        }

        const model = {
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
        }

        await provider.provideLanguageModelChatResponse(
          model as never,
          [
            {
              role: 1, // User
              content: [{ value: "Hello" }],
            },
          ] as never,
          { tools: [], toolMode: undefined } as never,
          progress as never,
          makeToken() as never,
        )

        expect(parts).toEqual([
          { type: "text", value: "Hello" },
          { type: "text", value: " from" },
          { type: "text", value: " Butter!" },
        ])

        provider.dispose()
      } finally {
        void server.stop()
      }
    })
  })

  describe("provideTokenCount", () => {
    it("uses the count_tokens endpoint when available", async () => {
      const server = serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === "/v1/messages/count_tokens") {
            const body = (await req.json()) as { model: string; messages: unknown[] }
            expect(body.model).toBe("claude-3")
            expect(body.messages).toHaveLength(1)
            return new Response(JSON.stringify({ input_tokens: 123 }), {
              headers: { "Content-Type": "application/json" },
            })
          }
          return new Response("Not Found", { status: 404 })
        },
      })

      try {
        const provider = new ButterChatModelProvider(
          () => `http://localhost:${server.port}`,
          makeOutputChannel() as never,
        )

        const count = await provider.provideTokenCount(
          { id: "claude-3" } as never,
          "Hello, world!",
          makeToken() as never,
        )

        expect(count).toBe(123)
        provider.dispose()
      } finally {
        void server.stop()
      }
    })

    it("falls back to the heuristic when the endpoint is unreachable", async () => {
      const provider = new ButterChatModelProvider(
        () => "http://localhost:8091",
        makeOutputChannel() as never,
      )

      const count = await provider.provideTokenCount(
        { id: "claude-3" } as never,
        "Hello, world!", // 13 chars → ~4 tokens
        makeToken() as never,
      )

      expect(count).toBe(Math.ceil(13 / 4))
      provider.dispose()
    })

    it("never estimates 0 tokens for a non-empty message with an unexpected shape", async () => {
      const provider = new ButterChatModelProvider(
        () => "http://localhost:8091", // unreachable → heuristic fallback
        makeOutputChannel() as never,
      )

      // A message whose content parts don't match any known LanguageModel*Part
      // class (e.g. a future/proposed shape). The structured walk yields 0, so
      // the heuristic must fall back to serializing the whole message.
      const message = {
        role: 1,
        content: [{ kind: "future-part", value: "some meaningful content here" }],
      } as never

      const count = await provider.provideTokenCount(
        { id: "claude-3" } as never,
        message,
        makeToken() as never,
      )

      expect(count).toBeGreaterThan(0)
      provider.dispose()
    })

    it("estimates 0 tokens only for a truly empty message", async () => {
      const provider = new ButterChatModelProvider(
        () => "http://localhost:8091", // unreachable → heuristic fallback
        makeOutputChannel() as never,
      )

      const count = await provider.provideTokenCount(
        { id: "claude-3" } as never,
        { role: 1, content: [] } as never,
        makeToken() as never,
      )

      // An empty message serializes to a small object; ensure we don't crash
      // and produce a small, finite count.
      expect(Number.isFinite(count)).toBe(true)
      expect(count).toBeGreaterThanOrEqual(0)
      provider.dispose()
    })

    it("warns once on 403 and stops calling the endpoint", async () => {
      warningMessages.length = 0
      let calls = 0
      const server = serve({
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === "/v1/messages/count_tokens") {
            calls++
            return new Response(
              JSON.stringify({ type: "error", error: { type: "permission_error" } }),
              { status: 403, headers: { "Content-Type": "application/json" } },
            )
          }
          return new Response("Not Found", { status: 404 })
        },
      })

      try {
        const provider = new ButterChatModelProvider(
          () => `http://localhost:${server.port}`,
          makeOutputChannel() as never,
        )

        // First call hits the endpoint, gets 403, falls back to heuristic.
        const first = await provider.provideTokenCount(
          { id: "claude-3" } as never,
          "Hello, world!",
          makeToken() as never,
        )
        expect(first).toBe(Math.ceil(13 / 4))
        expect(calls).toBe(1)
        expect(warningMessages).toHaveLength(1)
        expect(warningMessages[0]).toContain("bedrock-mantle:CountTokens")

        // Second call must NOT hit the endpoint again (disabled for session).
        const second = await provider.provideTokenCount(
          { id: "claude-3" } as never,
          "Hello again!",
          makeToken() as never,
        )
        expect(second).toBe(Math.ceil("Hello again!".length / 4))
        expect(calls).toBe(1)
        expect(warningMessages).toHaveLength(1)

        provider.dispose()
      } finally {
        void server.stop()
      }
    })
  })

  describe("notifyModelsChanged", () => {
    it("re-fetches models on next request after notification", async () => {
      let fetchCount = 0
      const server = serve({
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === "/v1/models") {
            fetchCount++
            return new Response(
              JSON.stringify({
                data: [{ id: "claude-sonnet-4-20250514" }],
              }),
              { headers: { "Content-Type": "application/json" } },
            )
          }
          return new Response("Not Found", { status: 404 })
        },
      })

      try {
        const provider = new ButterChatModelProvider(
          () => `http://localhost:${server.port}`,
          makeOutputChannel() as never,
        )

        // First fetch
        await provider.provideLanguageModelChatInformation({}, makeToken() as never)
        expect(fetchCount).toBe(1)

        // notifyModelsChanged fires the change event; the next request always
        // re-fetches from Butter (the cache is only a fallback for failed fetches).
        provider.notifyModelsChanged()

        await provider.provideLanguageModelChatInformation({}, makeToken() as never)
        expect(fetchCount).toBe(2)

        provider.dispose()
      } finally {
        void server.stop()
      }
    })

    it("serves the last known-good list when a post-notify re-fetch fails", async () => {
      let baseUrl = ""
      const server = serve({
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === "/v1/models") {
            return new Response(
              JSON.stringify({
                data: [{ id: "claude-sonnet-4-20250514" }, { id: "claude-3-5-haiku-20241022" }],
              }),
              { headers: { "Content-Type": "application/json" } },
            )
          }
          return new Response("Not Found", { status: 404 })
        },
      })

      try {
        baseUrl = `http://localhost:${server.port}`
        const provider = new ButterChatModelProvider(() => baseUrl, makeOutputChannel() as never)

        const first = await provider.provideLanguageModelChatInformation({}, makeToken() as never)
        expect(first).toHaveLength(2)

        // Simulate a Butter restart: notify, then the next fetch races the port
        // binding and fails. The provider should still serve the cached list.
        provider.notifyModelsChanged()
        baseUrl = "http://localhost:1" // unreachable

        const afterRestart = await provider.provideLanguageModelChatInformation(
          {},
          makeToken() as never,
        )
        expect(afterRestart).toHaveLength(2)

        provider.dispose()
      } finally {
        void server.stop()
      }
    })
  })
})

/** Helper: build a single Anthropic SSE event */
function sseEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}
