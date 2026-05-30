import { describe, expect, test } from "bun:test"

import { bedrockIdToFriendlyId } from "./inferenceProfileManager"

describe("bedrockIdToFriendlyId", () => {
  test("converts foundation model ID with version suffix", () => {
    expect(bedrockIdToFriendlyId("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      "claude-sonnet-4-5-20250929",
    )
  })

  test("converts foundation model ID without version suffix", () => {
    expect(bedrockIdToFriendlyId("anthropic.claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
  })

  test("handles us. prefix from cross-region profiles", () => {
    expect(bedrockIdToFriendlyId("us.anthropic.claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
  })

  test("handles global. prefix", () => {
    expect(bedrockIdToFriendlyId("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "claude-haiku-4-5-20251001",
    )
  })

  test("returns null for non-Anthropic models", () => {
    expect(bedrockIdToFriendlyId("amazon.titan-text-express-v1")).toBeNull()
  })

  test("returns null for model IDs missing anthropic prefix", () => {
    expect(bedrockIdToFriendlyId("claude-sonnet-4-6")).toBeNull()
  })
})
