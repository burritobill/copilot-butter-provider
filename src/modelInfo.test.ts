import { describe, expect, it } from "bun:test"

import { modelToInfo } from "./modelInfo"

describe("modelToInfo", () => {
  it("returns known model info for claude-sonnet-4-20250514", () => {
    const info = modelToInfo("claude-sonnet-4-20250514")
    expect(info.id).toBe("claude-sonnet-4-20250514")
    expect(info.name).toBe("Claude Sonnet 4")
    expect(info.family).toBe("claude-sonnet")
    expect(info.version).toBe("20250514")
    expect(info.maxInputTokens).toBe(200_000)
    expect(info.maxOutputTokens).toBe(16_384)
    expect(info.capabilities.toolCalling).toBe(true)
    expect(info.capabilities.imageInput).toBe(true)
  })

  it("returns known model info for claude-3-5-haiku", () => {
    const info = modelToInfo("claude-3-5-haiku-20241022")
    expect(info.id).toBe("claude-3-5-haiku-20241022")
    expect(info.name).toBe("Claude 3.5 Haiku")
    expect(info.family).toBe("claude-haiku")
    expect(info.maxOutputTokens).toBe(8_192)
  })

  it("returns reasonable defaults for unknown models", () => {
    const info = modelToInfo("claude-4-ultra-20260101")
    expect(info.id).toBe("claude-4-ultra-20260101")
    expect(info.version).toBe("20260101")
    expect(info.maxInputTokens).toBe(200_000)
    expect(info.maxOutputTokens).toBe(8_192)
    expect(info.capabilities.toolCalling).toBe(true)
  })

  it("handles model IDs without version suffix", () => {
    const info = modelToInfo("some-custom-model")
    expect(info.id).toBe("some-custom-model")
    expect(info.version).toBe("unknown")
    expect(info.capabilities.toolCalling).toBe(true)
  })

  it("joins consecutive numeric segments with a dot", () => {
    expect(modelToInfo("claude-opus-4-8").name).toBe("Claude Opus 4.8")
    expect(modelToInfo("claude-sonnet-4-6").name).toBe("Claude Sonnet 4.6")
    expect(modelToInfo("claude-opus-4-7").name).toBe("Claude Opus 4.7")
  })

  it("strips date suffix before building dotted name", () => {
    expect(modelToInfo("claude-opus-4-1-20250805").name).toBe("Claude Opus 4.1")
    expect(modelToInfo("claude-sonnet-4-5-20250929").name).toBe("Claude Sonnet 4.5")
  })

  it("strips trailing version segment before building dotted name", () => {
    expect(modelToInfo("claude-opus-4-6-v1").name).toBe("Claude Opus 4.6")
    expect(modelToInfo("us.anthropic.claude-sonnet-4-6-v1:0").name).toBe("Claude Sonnet 4.6")
  })
})
