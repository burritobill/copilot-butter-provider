import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock"
import { fromIni } from "@aws-sdk/credential-providers"
import * as vscode from "vscode"

import { InferenceProfileManager } from "./inferenceProfileManager"

interface ButterConfig {
  server: { address: string; read_timeout: string; write_timeout: string }
  providers: Record<string, unknown>
  routing: {
    default_provider: string
    models: Record<string, { providers: string[]; strategy: string }>
    failover: {
      enabled: boolean
      max_retries: number
      retry_on: number[]
      backoff: { initial: string; multiplier: number; max: string }
    }
  }
  plugins: Record<string, unknown>
}

export class ConfigManager {
  private outputChannel: vscode.OutputChannel

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel
  }

  getConfigPath(): string {
    const configured = vscode.workspace
      .getConfiguration("butter-copilot")
      .get<string>("configPath", "~/.butter-copilot/config.yaml")
    return configured.replace(/^~/, process.env.HOME ?? "~")
  }

  async ensureConfig(): Promise<string> {
    const configPath = this.getConfigPath()
    try {
      await readFile(configPath, "utf-8")
      this.outputChannel.appendLine(`Using existing config at ${configPath}`)
      return configPath
    } catch {
      return this.writeConfig(configPath)
    }
  }

  async resetConfig(): Promise<string> {
    return this.writeConfig(this.getConfigPath())
  }

  async updateConfig(): Promise<string> {
    return this.writeConfig(this.getConfigPath())
  }

  private async writeConfig(configPath: string): Promise<string> {
    const config = await this.buildConfig()
    const yaml = serializeYaml(config as unknown as Record<string, unknown>)

    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, yaml)
    this.outputChannel.appendLine(`Wrote config to ${configPath}`)
    return configPath
  }

  private async buildConfig(): Promise<ButterConfig> {
    const settings = vscode.workspace.getConfiguration("butter-copilot")
    const port = settings.get<number>("port", 8091)
    const region = settings.get<string>("awsRegion", "us-west-2")
    const profile = settings.get<string>("awsProfile", "")
    const userModelMap = settings.get<Record<string, string>>("modelMap", {})
    const logLevel = settings.get<string>("logLevel", "info")
    const logBodies = settings.get<boolean>("logBodies", false)
    const bodyMaxBytes = settings.get<number>("bodyMaxBytes", 4096)

    const bedrock: Record<string, unknown> = { region }
    if (profile) bedrock.aws_profile = profile

    // Discover models and build the model_map (friendly name → Bedrock identifier)
    const { friendlyIds, bedrockModelMap } = await this.discoverBedrockModels(region, profile)

    // If inference profiles are enabled, overlay profile ARNs onto the model_map
    const useInferenceProfiles = settings.get<boolean>("useInferenceProfiles", false)
    if (useInferenceProfiles) {
      const profileOverrides = await this.discoverInferenceProfileModelMap(
        region,
        profile,
        friendlyIds,
      )
      Object.assign(bedrockModelMap, profileOverrides)
    }

    // User overrides take highest priority
    Object.assign(bedrockModelMap, userModelMap)

    // Set model_map on the bedrock provider config (Butter uses this to resolve model IDs)
    if (Object.keys(bedrockModelMap).length > 0) bedrock.model_map = bedrockModelMap

    const models: Record<string, { providers: string[]; strategy: string }> = {}
    for (const id of friendlyIds) {
      models[id] = { providers: ["bedrock"], strategy: "priority" }
    }

    return {
      server: {
        address: `127.0.0.1:${port}`,
        read_timeout: "30s",
        write_timeout: "120s",
      },
      providers: { bedrock },
      routing: {
        default_provider: "bedrock",
        models,
        failover: {
          enabled: true,
          max_retries: 3,
          retry_on: [429, 500, 502, 503, 504],
          backoff: { initial: "100ms", multiplier: 2.0, max: "5s" },
        },
      },
      plugins: {
        // requestlog emits a structured JSON line per request to stdout, which
        // the extension taps for the dashboard's recent-requests list and the
        // butter_analyzeUsage tool. Bodies are opt-in (may contain source/secrets).
        requestlog: {
          level: logLevel,
          log_bodies: logBodies,
          body_max_bytes: bodyMaxBytes,
        },
        // requesttraces exposes a bounded in-memory request history at
        // GET /v1/requests so all VS Code windows can read recent traces,
        // even when they adopt an existing Butter process.
        requesttraces: {
          max_entries: 500,
          include_bodies: logBodies,
          body_max_bytes: bodyMaxBytes,
        },
        // metrics exposes Prometheus aggregates at GET /metrics on the same port,
        // powering the dashboard charts. Presence of the key enables the plugin.
        metrics: {},
      },
    }
  }

  /**
   * Query Bedrock for available Anthropic models.
   * Returns friendly model IDs (for routing/display) and a model_map
   * that maps friendly IDs to cross-region Bedrock identifiers (us.anthropic.*).
   */
  private async discoverBedrockModels(
    region: string,
    profile: string,
  ): Promise<{ friendlyIds: string[]; bedrockModelMap: Record<string, string> }> {
    try {
      const bedrock = new BedrockClient({
        region,
        ...(profile ? { credentials: fromIni({ profile }) } : {}),
      })
      const result = await bedrock.send(
        new ListFoundationModelsCommand({
          byProvider: "Anthropic",
          byOutputModality: "TEXT",
        }),
      )

      const entries = (result.modelSummaries ?? [])
        .filter((m) => m.modelLifecycle?.status !== "LEGACY")
        .filter((m) => m.modelId?.startsWith("anthropic."))
        .map((m) => {
          const bedrockId = m.modelId!
          // Strip "anthropic." prefix and version suffix for friendly name
          let friendly = bedrockId.slice("anthropic.".length)
          friendly = friendly.replace(/-v\d+:\d+$/, "")
          return { friendly, crossRegionId: `us.${bedrockId}` }
        })

      if (entries.length > 0) {
        const friendlyIds = entries.map((e) => e.friendly)
        const bedrockModelMap: Record<string, string> = {}
        for (const e of entries) {
          bedrockModelMap[e.friendly] = e.crossRegionId
        }
        this.outputChannel.appendLine(
          `Discovered ${friendlyIds.length} Bedrock models: ${friendlyIds.join(", ")}`,
        )
        return { friendlyIds, bedrockModelMap }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`Failed to discover Bedrock models, using defaults: ${msg}`)
    }

    return { friendlyIds: DEFAULT_MODELS, bedrockModelMap: {} }
  }

  /**
   * Discover inference profiles and return a model_map overlay
   * that maps friendly model names to inference profile ARNs.
   */
  private async discoverInferenceProfileModelMap(
    region: string,
    awsProfile: string,
    friendlyIds: string[],
  ): Promise<Record<string, string>> {
    try {
      const manager = new InferenceProfileManager(this.outputChannel)
      const userId = await manager.detectUserId(region, awsProfile)
      const profiles = await manager.listUserProfiles(region, awsProfile, userId)

      // Match profiles to friendly IDs via the model-id tag
      const overrides: Record<string, string> = {}
      for (const profile of profiles) {
        // profile.modelId is like "anthropic.claude-sonnet-4-6"
        let friendly = profile.modelId.replace(/^anthropic\./, "")
        friendly = friendly.replace(/-v\d+:\d+$/, "")
        if (friendlyIds.includes(friendly)) {
          overrides[friendly] = profile.profileArn
        }
      }

      if (Object.keys(overrides).length > 0) {
        this.outputChannel.appendLine(
          `Using inference profile ARNs for: ${Object.keys(overrides).join(", ")}`,
        )
      }

      return overrides
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`Failed to discover inference profiles: ${msg}`)
      return {}
    }
  }
}

const DEFAULT_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
]

/**
 * Minimal YAML serializer — covers the flat/nested object shapes Butter needs
 * without pulling in a YAML library.
 */
export function serializeYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent)
  let out = ""

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue

    if (Array.isArray(value)) {
      out += `${pad}${key}:\n`
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          out += `${pad}  - ${serializeYaml(item as Record<string, unknown>, indent + 2).trimStart()}`
        } else {
          out += `${pad}  - ${item}\n`
        }
      }
    } else if (typeof value === "object") {
      out += `${pad}${key}:\n`
      out += serializeYaml(value as Record<string, unknown>, indent + 1)
    } else if (typeof value === "string") {
      // Quote strings that contain special YAML chars
      const needsQuote = /[:{},&*#?|<>=!%@`'"[\]]/.test(value) || value === ""
      out += `${pad}${key}: ${needsQuote ? `"${value}"` : value}\n`
    } else if (typeof value === "number" || typeof value === "boolean") {
      out += `${pad}${key}: ${value}\n`
    }
  }

  return out
}
