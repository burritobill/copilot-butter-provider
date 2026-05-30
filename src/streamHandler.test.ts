import { describe, expect, it, mock } from "bun:test"

// Track reported parts for assertions
const reportedParts: Array<{ type: string; [key: string]: unknown }> = []

void mock.module("vscode", () => ({
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
}))

const { streamAnthropicMessages } = await import("./streamHandler")

/** Build a mock Anthropic SSE stream from event/data pairs */
function makeAnthropicSSEStream(
  events: Array<{ event: string; data: object }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const lines = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("")

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines))
      controller.close()
    },
  })
}

function mockToken(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose() {} }),
  }
}

function mockProgress() {
  reportedParts.length = 0
  return {
    report(part: { value?: string; callId?: string; name?: string; input?: object }) {
      if ("value" in part) {
        reportedParts.push({ type: "text", value: part.value })
      } else if ("callId" in part) {
        reportedParts.push({
          type: "toolCall",
          callId: part.callId,
          name: part.name,
          input: part.input,
        })
      }
    },
  }
}

describe("streamAnthropicMessages", () => {
  it("streams text content", async () => {
    const body = makeAnthropicSSEStream([
      {
        event: "message_start",
        data: { type: "message_start", message: { id: "msg_1", role: "assistant" } },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_stop", data: { type: "message_stop" } },
    ])

    const mockFetch = mock(() => Promise.resolve(new Response(body, { status: 200 })))
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      const progress = mockProgress()
      await streamAnthropicMessages(
        "http://localhost:8091",
        { model: "test", max_tokens: 100, messages: [], stream: true },
        progress as never,
        mockToken() as never,
      )

      expect(reportedParts).toEqual([
        { type: "text", value: "Hello" },
        { type: "text", value: " world" },
        { type: "text", value: "!" },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("accumulates tool use blocks", async () => {
    const body = makeAnthropicSSEStream([
      {
        event: "message_start",
        data: { type: "message_start", message: { id: "msg_1", role: "assistant" } },
      },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"ci' },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: 'ty":"' },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: 'NYC"}' },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_stop", data: { type: "message_stop" } },
    ])

    const mockFetch = mock(() => Promise.resolve(new Response(body, { status: 200 })))
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      const progress = mockProgress()
      await streamAnthropicMessages(
        "http://localhost:8091",
        { model: "test", max_tokens: 100, messages: [], stream: true },
        progress as never,
        mockToken() as never,
      )

      expect(reportedParts).toHaveLength(1)
      expect(reportedParts[0]).toEqual({
        type: "toolCall",
        callId: "toolu_1",
        name: "get_weather",
        input: { city: "NYC" },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("handles mixed text and tool calls", async () => {
    const body = makeAnthropicSSEStream([
      {
        event: "message_start",
        data: { type: "message_start", message: { id: "msg_1", role: "assistant" } },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Let me check." },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"city":"NYC"}' },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
      { event: "message_stop", data: { type: "message_stop" } },
    ])

    const mockFetch = mock(() => Promise.resolve(new Response(body, { status: 200 })))
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      const progress = mockProgress()
      await streamAnthropicMessages(
        "http://localhost:8091",
        { model: "test", max_tokens: 100, messages: [], stream: true },
        progress as never,
        mockToken() as never,
      )

      expect(reportedParts).toHaveLength(2)
      expect(reportedParts[0]).toEqual({ type: "text", value: "Let me check." })
      expect(reportedParts[1]).toEqual({
        type: "toolCall",
        callId: "toolu_1",
        name: "get_weather",
        input: { city: "NYC" },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("throws on non-OK response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      const progress = mockProgress()
      expect(
        streamAnthropicMessages(
          "http://localhost:8091",
          { model: "test", max_tokens: 100, messages: [], stream: true },
          progress as never,
          mockToken() as never,
        ),
      ).rejects.toThrow("Butter returned 500")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("handles empty stream", async () => {
    const body = makeAnthropicSSEStream([])

    const mockFetch = mock(() => Promise.resolve(new Response(body, { status: 200 })))
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      const progress = mockProgress()
      await streamAnthropicMessages(
        "http://localhost:8091",
        { model: "test", max_tokens: 100, messages: [], stream: true },
        progress as never,
        mockToken() as never,
      )
      expect(reportedParts).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
