import type * as vscode from "vscode"

/** Known model capabilities for Claude models on Bedrock */
interface ModelCapabilities {
  name: string
  family: string
  version: string
  maxInputTokens: number
  maxOutputTokens: number
  toolCalling: boolean
  imageInput: boolean
  /** Relative cost tier — lower values make VS Code prefer the model for subagents. */
  costTier: number
}

/** Cost tier constants matching Copilot's own model multipliers. */
const COST_HAIKU = 1
const COST_SONNET = 10
const COST_OPUS = 100

/**
 * Known model lookup table. Models not in this table get reasonable defaults.
 */
const KNOWN_MODELS: Record<string, ModelCapabilities> = {
  "claude-sonnet-4-20250514": {
    name: "Claude Sonnet 4",
    family: "claude-sonnet",
    version: "20250514",
    maxInputTokens: 200_000,
    maxOutputTokens: 16_384,
    toolCalling: true,
    imageInput: true,
    costTier: COST_SONNET,
  },
  "claude-opus-4-20250514": {
    name: "Claude Opus 4",
    family: "claude-opus",
    version: "20250514",
    maxInputTokens: 200_000,
    maxOutputTokens: 16_384,
    toolCalling: true,
    imageInput: true,
    costTier: COST_OPUS,
  },
  "claude-3-7-sonnet-20250219": {
    name: "Claude 3.7 Sonnet",
    family: "claude-sonnet",
    version: "20250219",
    maxInputTokens: 200_000,
    maxOutputTokens: 16_384,
    toolCalling: true,
    imageInput: true,
    costTier: COST_SONNET,
  },
  "claude-3-5-sonnet-20241022": {
    name: "Claude 3.5 Sonnet",
    family: "claude-sonnet",
    version: "20241022",
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    toolCalling: true,
    imageInput: true,
    costTier: COST_SONNET,
  },
  "claude-3-5-haiku-20241022": {
    name: "Claude 3.5 Haiku",
    family: "claude-haiku",
    version: "20241022",
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    toolCalling: true,
    imageInput: true,
    costTier: COST_HAIKU,
  },
  "claude-3-opus-20240229": {
    name: "Claude 3 Opus",
    family: "claude-opus",
    version: "20240229",
    maxInputTokens: 200_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    imageInput: true,
    costTier: COST_OPUS,
  },
  "claude-3-haiku-20240307": {
    name: "Claude 3 Haiku",
    family: "claude-haiku",
    version: "20240307",
    maxInputTokens: 200_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    imageInput: true,
    costTier: COST_HAIKU,
  },
}

/** Response shape from GET /v1/models */
interface ModelsResponse {
  data: Array<{ id: string; object: string; owned_by?: string }>
}

/**
 * Fetch available models from Butter's /v1/models endpoint.
 */
export async function fetchModels(baseUrl: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/v1/models`)

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status}`)
  }

  const body = (await response.json()) as ModelsResponse
  return body.data.map((m) => m.id)
}

/**
 * Map a model ID to LanguageModelChatInformation.
 */
export function modelToInfo(modelId: string): vscode.LanguageModelChatInformation {
  const known = KNOWN_MODELS[modelId]

  if (known) {
    return {
      id: modelId,
      name: known.name,
      family: known.family,
      version: known.version,
      maxInputTokens: known.maxInputTokens,
      maxOutputTokens: known.maxOutputTokens,
      multiplierNumeric: known.costTier,
      capabilities: {
        toolCalling: known.toolCalling,
        imageInput: known.imageInput,
      },
    }
  }

  // Unknown model — derive info from the model ID
  const { name, family, version } = parseModelId(modelId)
  // Infer cost tier from family name for unknown models
  const costTier = family.includes("haiku")
    ? COST_HAIKU
    : family.includes("opus")
      ? COST_OPUS
      : COST_SONNET
  return {
    id: modelId,
    name,
    family,
    version,
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    multiplierNumeric: costTier,
    capabilities: { toolCalling: true, imageInput: true },
  }
}

/**
 * Parse a model ID into name/family/version.
 * Handles Bedrock cross-region IDs like "us.anthropic.claude-sonnet-4-6"
 * and plain IDs like "claude-3-5-sonnet-20241022".
 */
function parseModelId(modelId: string): { name: string; family: string; version: string } {
  // Strip "us.anthropic." or similar region/vendor prefix
  let id = modelId.replace(/^[a-z]+\.anthropic\./, "")
  // Strip version suffix like "-v1:0", "-v2:0"
  id = id.replace(/-v\d+:\d+$/, "")
  // Strip a trailing bare version segment like "-v1", "-v2"
  id = id.replace(/-v\d+$/, "")

  // Try to extract a date-like version suffix (YYYYMMDD)
  const versionMatch = id.match(/(\d{8})$/)
  const version = versionMatch ? versionMatch[1]! : "unknown"

  // Strip the version to get the family
  const base = versionMatch ? id.slice(0, -9) : id // -9 = "-YYYYMMDD"
  const family = base.replace(/-\d+/g, "").replace(/-$/, "")

  // Build a display name: capitalize word segments and join with spaces, but
  // join consecutive numeric segments with a dot (e.g. "4-8" → "4.8").
  const segments = base.split("-")
  let name = ""
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const prev = segments[i - 1]
    const isNumeric = /^\d+$/.test(seg)
    const prevIsNumeric = prev !== undefined && /^\d+$/.test(prev)

    if (i === 0) {
      name = capitalize(seg)
    } else if (isNumeric && prevIsNumeric) {
      name += `.${seg}`
    } else {
      name += ` ${capitalize(seg)}`
    }
  }

  return { name, family, version }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
