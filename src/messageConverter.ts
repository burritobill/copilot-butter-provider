import type * as vscode from "vscode"

/** OpenAI chat completions message format */
export interface OpenAIMessage {
  role: "user" | "assistant" | "system" | "tool"
  content?: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

interface OpenAIContentPart {
  type: "text" | "image_url"
  text?: string
  image_url?: { url: string }
}

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface OpenAITool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** Anthropic Messages API format */
export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: object }
  | { type: "tool_result"; tool_use_id: string; content: string }

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

// VS Code LanguageModelChatMessageRole enum values
const ROLE_USER = 1

/**
 * Convert VS Code LanguageModelChatRequestMessage[] to OpenAI chat completions messages.
 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  for (const msg of messages) {
    const role = msg.role === ROLE_USER ? "user" : "assistant"

    // Check if message contains tool calls (assistant) or tool results (user)
    const toolCalls = extractToolCalls(msg.content)
    const toolResults = extractToolResults(msg.content)

    if (toolResults.length > 0) {
      // Tool result messages become separate "tool" role messages
      for (const toolResult of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: toolResult.callId,
          content: toolResult.text,
        })
      }
      // Also include any text parts as a regular user message
      const textContent = extractText(msg.content)
      if (textContent) {
        result.push({ role, content: textContent })
      }
    } else if (toolCalls.length > 0) {
      // Assistant message with tool calls
      const textContent = extractText(msg.content)
      result.push({
        role: "assistant",
        content: textContent || null,
        tool_calls: toolCalls,
      })
    } else {
      // Regular text (possibly with images)
      const parts = buildContentParts(msg.content)
      if (parts.length === 1 && parts[0]!.type === "text") {
        result.push({ role, content: parts[0]!.text, name: msg.name ?? undefined })
      } else if (parts.length > 0) {
        result.push({ role, content: parts, name: msg.name ?? undefined })
      } else {
        result.push({ role, content: "" })
      }
    }
  }

  return result
}

/**
 * Convert VS Code LanguageModelChatTool[] to OpenAI tool format.
 */
export function convertTools(tools: readonly vscode.LanguageModelChatTool[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown> | undefined,
    },
  }))
}

// Duck-type checks — avoids runtime dependency on vscode module

function isTextPart(part: unknown): part is { value: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    "value" in part &&
    typeof (part as { value: unknown }).value === "string" &&
    !("callId" in part) &&
    !("mimeType" in part)
  )
}

function isToolCallPart(part: unknown): part is { callId: string; name: string; input: object } {
  return (
    typeof part === "object" &&
    part !== null &&
    "callId" in part &&
    "name" in part &&
    "input" in part
  )
}

function isToolResultPart(part: unknown): part is { callId: string; content: unknown[] } {
  return (
    typeof part === "object" &&
    part !== null &&
    "callId" in part &&
    "content" in part &&
    !("name" in part)
  )
}

function isDataPart(part: unknown): part is { data: Uint8Array; mimeType: string } {
  return typeof part === "object" && part !== null && "data" in part && "mimeType" in part
}

function extractText(content: ReadonlyArray<unknown>): string {
  const texts: string[] = []
  for (const part of content) {
    if (isTextPart(part)) {
      texts.push(part.value)
    }
  }
  return texts.join("")
}

function extractToolCalls(content: ReadonlyArray<unknown>): OpenAIToolCall[] {
  const calls: OpenAIToolCall[] = []
  for (const part of content) {
    if (isToolCallPart(part)) {
      calls.push({
        id: part.callId,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input),
        },
      })
    }
  }
  return calls
}

interface ToolResultEntry {
  callId: string
  text: string
}

function extractToolResults(content: ReadonlyArray<unknown>): ToolResultEntry[] {
  const results: ToolResultEntry[] = []
  for (const part of content) {
    if (isToolResultPart(part)) {
      const texts: string[] = []
      for (const item of part.content) {
        if (isTextPart(item)) {
          texts.push(item.value)
        } else if (typeof item === "string") {
          texts.push(item)
        }
      }
      results.push({ callId: part.callId, text: texts.join("") })
    }
  }
  return results
}

function buildContentParts(content: ReadonlyArray<unknown>): OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = []
  for (const part of content) {
    if (isTextPart(part)) {
      parts.push({ type: "text", text: part.value })
    } else if (isDataPart(part)) {
      if (part.mimeType.startsWith("image/")) {
        const b64 = Buffer.from(part.data).toString("base64")
        parts.push({
          type: "image_url",
          image_url: { url: `data:${part.mimeType};base64,${b64}` },
        })
      }
    }
  }
  return parts
}

/**
 * Convert VS Code LanguageModelChatRequestMessage[] to Anthropic Messages API format.
 */
export function convertToAnthropicMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): { messages: AnthropicMessage[] } {
  const result: AnthropicMessage[] = []

  for (const msg of messages) {
    const role: "user" | "assistant" = msg.role === ROLE_USER ? "user" : "assistant"

    const toolCalls = extractToolCallParts(msg.content)
    const toolResults = extractToolResultParts(msg.content)

    if (toolResults.length > 0) {
      const blocks: AnthropicContentBlock[] = []
      const text = extractText(msg.content)
      if (text) blocks.push({ type: "text", text })
      for (const tr of toolResults) {
        blocks.push({ type: "tool_result", tool_use_id: tr.callId, content: tr.text })
      }
      result.push({ role: "user", content: blocks })
    } else if (toolCalls.length > 0) {
      const blocks: AnthropicContentBlock[] = []
      const text = extractText(msg.content)
      if (text) blocks.push({ type: "text", text })
      for (const tc of toolCalls) {
        blocks.push({ type: "tool_use", id: tc.callId, name: tc.name, input: tc.input })
      }
      result.push({ role: "assistant", content: blocks })
    } else {
      const blocks = buildAnthropicContentBlocks(msg.content)
      if (blocks.length === 1 && blocks[0]!.type === "text") {
        result.push({ role, content: (blocks[0] as { type: "text"; text: string }).text })
      } else if (blocks.length > 0) {
        result.push({ role, content: blocks })
      } else {
        result.push({ role, content: "" })
      }
    }
  }

  return { messages: result }
}

/**
 * Convert VS Code LanguageModelChatTool[] to Anthropic tool format.
 */
export function convertAnthropicTools(
  tools: readonly vscode.LanguageModelChatTool[],
): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (tool.inputSchema as Record<string, unknown>) ?? {
      type: "object",
      properties: {},
    },
  }))
}

function extractToolCallParts(
  content: ReadonlyArray<unknown>,
): Array<{ callId: string; name: string; input: object }> {
  const calls: Array<{ callId: string; name: string; input: object }> = []
  for (const part of content) {
    if (isToolCallPart(part)) {
      calls.push({ callId: part.callId, name: part.name, input: part.input })
    }
  }
  return calls
}

function extractToolResultParts(
  content: ReadonlyArray<unknown>,
): Array<{ callId: string; text: string }> {
  const results: Array<{ callId: string; text: string }> = []
  for (const part of content) {
    if (isToolResultPart(part)) {
      const texts: string[] = []
      for (const item of part.content) {
        if (isTextPart(item)) texts.push(item.value)
        else if (typeof item === "string") texts.push(item)
      }
      results.push({ callId: part.callId, text: texts.join("") })
    }
  }
  return results
}

function buildAnthropicContentBlocks(content: ReadonlyArray<unknown>): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (isTextPart(part)) {
      blocks.push({ type: "text", text: part.value })
    } else if (isDataPart(part)) {
      if (part.mimeType.startsWith("image/")) {
        const b64 = Buffer.from(part.data).toString("base64")
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: part.mimeType, data: b64 },
        })
      }
    }
  }
  return blocks
}
