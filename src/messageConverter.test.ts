import { describe, expect, it } from "bun:test"

import {
  convertAnthropicTools,
  convertMessages,
  convertToAnthropicMessages,
  convertTools,
} from "./messageConverter"

describe("convertMessages", () => {
  it("converts a simple user text message", () => {
    const messages = [
      {
        role: 1, // User
        content: [{ value: "Hello" }],
        name: undefined,
      },
    ]

    const result = convertMessages(messages as never)
    expect(result).toEqual([{ role: "user", content: "Hello", name: undefined }])
  })

  it("converts an assistant text message", () => {
    const messages = [
      {
        role: 2, // Assistant
        content: [{ value: "Hi there" }],
        name: undefined,
      },
    ]

    const result = convertMessages(messages as never)
    expect(result).toEqual([{ role: "assistant", content: "Hi there", name: undefined }])
  })

  it("converts assistant tool calls", () => {
    const messages = [
      {
        role: 2, // Assistant
        content: [{ callId: "call-1", name: "search", input: { query: "test" } }],
        name: undefined,
      },
    ]

    const result = convertMessages(messages as never)
    expect(result).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "search", arguments: '{"query":"test"}' },
          },
        ],
      },
    ])
  })

  it("converts tool result messages", () => {
    const messages = [
      {
        role: 1, // User
        content: [{ callId: "call-1", content: [{ value: "result data" }] }],
        name: undefined,
      },
    ]

    const result = convertMessages(messages as never)
    expect(result).toEqual([{ role: "tool", tool_call_id: "call-1", content: "result data" }])
  })

  it("handles multi-turn conversation", () => {
    const messages = [
      { role: 1, content: [{ value: "What is 2+2?" }], name: undefined },
      { role: 2, content: [{ value: "4" }], name: undefined },
      { role: 1, content: [{ value: "Thanks" }], name: undefined },
    ]

    const result = convertMessages(messages as never)
    expect(result).toHaveLength(3)
    expect(result[0]!.role).toBe("user")
    expect(result[1]!.role).toBe("assistant")
    expect(result[2]!.role).toBe("user")
  })

  it("handles image data parts", () => {
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const messages = [
      {
        role: 1, // User
        content: [{ value: "What is this?" }, { data: imageData, mimeType: "image/png" }],
        name: undefined,
      },
    ]

    const result = convertMessages(messages as never)
    expect(result).toHaveLength(1)
    expect(result[0]!.role).toBe("user")

    const content = result[0]!.content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.type).toBe("text")
    expect(content[1]!.type).toBe("image_url")
  })
})

describe("convertTools", () => {
  it("converts VS Code tools to OpenAI format", () => {
    const tools = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]

    const result = convertTools(tools as unknown as import("vscode").LanguageModelChatTool[])
    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ])
  })
})

describe("convertToAnthropicMessages", () => {
  it("converts a simple user text message", () => {
    const messages = [{ role: 1, content: [{ value: "Hello" }], name: undefined }]
    const { messages: result } = convertToAnthropicMessages(messages as never)
    expect(result).toEqual([{ role: "user", content: "Hello" }])
  })

  it("converts assistant text message", () => {
    const messages = [{ role: 2, content: [{ value: "Hi there" }], name: undefined }]
    const { messages: result } = convertToAnthropicMessages(messages as never)
    expect(result).toEqual([{ role: "assistant", content: "Hi there" }])
  })

  it("converts assistant tool calls to tool_use blocks", () => {
    const messages = [
      {
        role: 2,
        content: [{ callId: "call-1", name: "search", input: { query: "test" } }],
        name: undefined,
      },
    ]
    const { messages: result } = convertToAnthropicMessages(messages as never)
    expect(result).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "search", input: { query: "test" } }],
      },
    ])
  })

  it("converts tool results to tool_result blocks", () => {
    const messages = [
      {
        role: 1,
        content: [{ callId: "call-1", content: [{ value: "result data" }] }],
        name: undefined,
      },
    ]
    const { messages: result } = convertToAnthropicMessages(messages as never)
    expect(result).toEqual([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "result data" }],
      },
    ])
  })

  it("handles image data as base64 image blocks", () => {
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const messages = [
      {
        role: 1,
        content: [{ value: "What is this?" }, { data: imageData, mimeType: "image/png" }],
        name: undefined,
      },
    ]
    const { messages: result } = convertToAnthropicMessages(messages as never)
    expect(result).toHaveLength(1)
    expect(result[0]!.role).toBe("user")
    const content = result[0]!.content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.type).toBe("text")
    expect(content[1]!.type).toBe("image")
  })
})

describe("convertAnthropicTools", () => {
  it("converts VS Code tools to Anthropic format", () => {
    const tools = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]
    const result = convertAnthropicTools(
      tools as unknown as import("vscode").LanguageModelChatTool[],
    )
    expect(result).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ])
  })
})
