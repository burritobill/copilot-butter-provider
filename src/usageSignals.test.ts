import { describe, expect, it } from "bun:test"

import type { RequestLogEntry } from "./requestLogStore"
import { computeUsageSignals } from "./usageSignals"

describe("computeUsageSignals", () => {
  it("detects context-pressure and tool-related failures", () => {
    const entries: RequestLogEntry[] = [
      {
        time: new Date().toISOString(),
        provider: "bedrock",
        model: "claude-sonnet-4-6",
        status: 400,
        durationMs: 120,
        path: "/v1/chat/completions",
        error: "context_length_exceeded",
      },
      {
        time: new Date().toISOString(),
        provider: "bedrock",
        model: "claude-sonnet-4-6",
        status: 500,
        durationMs: 99,
        path: "/v1/chat/completions",
        requestBody: '{"tools":[{"name":"x"}]}',
        error: "tool_call execution failed",
      },
      {
        time: new Date().toISOString(),
        provider: "bedrock",
        model: "claude-haiku-4-5",
        status: 200,
        durationMs: 60,
        path: "/v1/messages",
      },
    ]

    const s = computeUsageSignals(entries)
    expect(s.total).toBe(3)
    expect(s.failures).toBe(2)
    expect(s.contextPressureFailures).toBe(1)
    expect(s.toolRelatedRequests).toBe(1)
    expect(s.toolRelatedFailures).toBe(1)
    expect(s.topFailingModel).toBe("claude-sonnet-4-6")
    expect(s.topFailingEndpoint).toBe("/v1/chat/completions")
  })
})
