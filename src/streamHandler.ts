import * as vscode from "vscode"

import type { AnthropicContentBlock, AnthropicMessage, AnthropicTool } from "./messageConverter"

/** Anthropic streaming SSE event types */
interface AnthropicEvent {
  type: string
}

interface ContentBlockStart extends AnthropicEvent {
  type: "content_block_start"
  index: number
  content_block: { type: "text"; text: string } | { type: "tool_use"; id: string; name: string }
}

interface ContentBlockDelta extends AnthropicEvent {
  type: "content_block_delta"
  index: number
  delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string }
}

interface ContentBlockStop extends AnthropicEvent {
  type: "content_block_stop"
  index: number
}

interface MessageStart extends AnthropicEvent {
  type: "message_start"
  message: { usage?: { input_tokens?: number; output_tokens?: number } }
}

interface MessageDelta extends AnthropicEvent {
  type: "message_delta"
  usage?: { output_tokens?: number }
}

/** Token usage extracted from the Anthropic streaming response. */
export interface AnthropicUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface AnthropicMessagesRequest {
  model: string
  max_tokens: number
  anthropic_version?: string
  system?: string
  messages: AnthropicMessage[]
  tools?: AnthropicTool[]
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string }
  stream: true
}

/**
 * POST to Butter's /v1/messages with streaming, parse Anthropic SSE events,
 * and report progress via the VS Code progress callback.
 */
export async function streamAnthropicMessages(
  baseUrl: string,
  request: AnthropicMessagesRequest,
  progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
  token: vscode.CancellationToken,
): Promise<AnthropicUsage | undefined> {
  const controller = new AbortController()
  const cancelListener = token.onCancellationRequested(() => controller.abort())

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "unused",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Butter returned ${response.status}: ${body}`)
    }

    if (!response.body) {
      throw new Error("Response body is null")
    }

    return await parseAnthropicSSE(response.body, progress, token)
  } finally {
    cancelListener.dispose()
  }
}

/** Response shape from POST /v1/messages/count_tokens */
interface CountTokensResponse {
  input_tokens: number
}

/**
 * Error thrown when the count_tokens endpoint returns a non-OK status. Carries
 * the HTTP status and the upstream response body so callers can distinguish a
 * permission denial (403) from other failures.
 */
export class CountTokensError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`count_tokens returned ${status}`)
    this.name = "CountTokensError"
  }
}

/**
 * POST to Butter's /v1/messages/count_tokens to get an accurate token count
 * for the given messages. Returns the input token count, or `undefined` if the
 * endpoint returns an unexpected shape (caller falls back to a heuristic).
 * Throws CountTokensError on a non-OK HTTP status.
 */
export async function countTokens(
  baseUrl: string,
  model: string,
  messages: AnthropicMessage[],
  token: vscode.CancellationToken,
): Promise<number | undefined> {
  const controller = new AbortController()
  const cancelListener = token.onCancellationRequested(() => controller.abort())

  try {
    const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "unused",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new CountTokensError(response.status, body)
    }

    const body = (await response.json()) as CountTokensResponse
    if (typeof body.input_tokens === "number") {
      return body.input_tokens
    }
    return undefined
  } finally {
    cancelListener.dispose()
  }
}

/**
 * Parse an Anthropic SSE stream and report text/tool_call parts via progress.
 */
async function parseAnthropicSSE(
  body: ReadableStream<Uint8Array>,
  progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
  token: vscode.CancellationToken,
): Promise<AnthropicUsage | undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  // Track token usage from message_start / message_delta events
  let inputTokens = 0
  let outputTokens = 0

  // Track active tool_use blocks by index
  const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>()

  try {
    while (!token.isCancellationRequested) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      let currentEvent = ""

      for (const line of lines) {
        if (token.isCancellationRequested) break

        const trimmed = line.trim()
        if (trimmed === "") {
          currentEvent = ""
          continue
        }

        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7)
          continue
        }

        if (!trimmed.startsWith("data: ")) continue
        const data = trimmed.slice(6)

        let event: AnthropicEvent
        try {
          event = JSON.parse(data) as AnthropicEvent
        } catch {
          continue
        }

        switch (event.type) {
          case "content_block_start": {
            const e = event as ContentBlockStart
            if (e.content_block.type === "tool_use") {
              pendingToolCalls.set(e.index, {
                id: e.content_block.id,
                name: e.content_block.name,
                arguments: "",
              })
            }
            break
          }

          case "content_block_delta": {
            const e = event as ContentBlockDelta
            if (e.delta.type === "text_delta") {
              progress.report(new vscode.LanguageModelTextPart(e.delta.text))
            } else if (e.delta.type === "input_json_delta") {
              const tc = pendingToolCalls.get(e.index)
              if (tc) tc.arguments += e.delta.partial_json
            }
            break
          }

          case "content_block_stop": {
            const e = event as ContentBlockStop
            const tc = pendingToolCalls.get(e.index)
            if (tc) {
              let input: object
              try {
                input = JSON.parse(tc.arguments) as object
              } catch {
                input = {}
              }
              progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, input))
              pendingToolCalls.delete(e.index)
            }
            break
          }

          case "message_start": {
            const e = event as MessageStart
            if (e.message?.usage) {
              inputTokens = e.message.usage.input_tokens ?? 0
              outputTokens = e.message.usage.output_tokens ?? 0
            }
            break
          }

          case "message_delta": {
            const e = event as MessageDelta
            if (e.usage?.output_tokens !== undefined) {
              outputTokens = e.usage.output_tokens
            }
            break
          }
        }
      }
    }

    // Emit any remaining tool calls if stream ended unexpectedly
    for (const [, tc] of pendingToolCalls) {
      let input: object
      try {
        input = JSON.parse(tc.arguments) as object
      } catch {
        input = {}
      }
      progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, input))
    }

    // Return collected usage if any tokens were reported
    if (inputTokens > 0 || outputTokens > 0) {
      return {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      }
    }
    return undefined
  } finally {
    reader.releaseLock()
  }
}
