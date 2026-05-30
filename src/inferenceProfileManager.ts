import { createHash } from "node:crypto"

import {
  BedrockClient,
  CreateInferenceProfileCommand,
  ListFoundationModelsCommand,
  type Tag,
} from "@aws-sdk/client-bedrock"
import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
} from "@aws-sdk/client-resource-groups-tagging-api"
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts"
import { fromIni } from "@aws-sdk/credential-providers"
import type * as vscode from "vscode"

export interface InferenceProfile {
  profileArn: string
  modelId: string
  tags: Record<string, string>
}

export class InferenceProfileManager {
  private outputChannel: vscode.OutputChannel

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel
  }

  private clientConfig(region: string, awsProfile: string) {
    return {
      region,
      ...(awsProfile ? { credentials: fromIni({ profile: awsProfile }) } : {}),
    }
  }

  async detectUserId(region: string, awsProfile: string): Promise<string> {
    const sts = new STSClient(this.clientConfig(region, awsProfile))
    const result = await sts.send(new GetCallerIdentityCommand({}))

    const arn = result.Arn
    if (!arn) throw new Error("STS returned no ARN")

    // Parse: arn:aws:sts::<account>:assumed-role/<role>/<user@domain.com>
    const parts = arn.split("/")
    if (parts.length === 3 && parts[0]!.endsWith(":assumed-role")) {
      return parts[2]!
    }
    throw new Error(`Could not parse user identity from ARN: ${arn}`)
  }

  async listUserProfiles(
    region: string,
    awsProfile: string,
    userId: string,
  ): Promise<InferenceProfile[]> {
    const tagging = new ResourceGroupsTaggingAPIClient(this.clientConfig(region, awsProfile))

    try {
      const result = await tagging.send(
        new GetResourcesCommand({
          ResourceTypeFilters: ["bedrock:application-inference-profile"],
          TagFilters: [
            { Key: "bedrock-user", Values: [userId] },
            { Key: "created-by", Values: ["wilma", "butter"] },
          ],
        }),
      )

      const profiles: InferenceProfile[] = []
      for (const resource of result.ResourceTagMappingList ?? []) {
        const tags: Record<string, string> = {}
        for (const tag of resource.Tags ?? []) {
          if (tag.Key && tag.Value) tags[tag.Key] = tag.Value
        }
        profiles.push({
          profileArn: resource.ResourceARN ?? "",
          modelId: tags["model-id"] ?? "",
          tags,
        })
      }

      this.outputChannel.appendLine(`Found ${profiles.length} inference profiles for ${userId}`)
      return profiles
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`Failed to list inference profiles: ${msg}`)
      return []
    }
  }

  async createProfile(
    region: string,
    awsProfile: string,
    userId: string,
    team: string,
    modelArn: string,
    modelId: string,
  ): Promise<InferenceProfile> {
    const bedrock = new BedrockClient(this.clientConfig(region, awsProfile))
    const profileName = generateProfileName(userId, modelId)
    const today = new Date().toISOString().slice(0, 10)
    const tags: Tag[] = [
      { key: "created-by", value: "butter" },
      { key: "bedrock-user", value: userId },
      { key: "team", value: team || "unspecified" },
      { key: "created-date", value: today },
      { key: "model-id", value: modelId },
    ]

    const result = await bedrock.send(
      new CreateInferenceProfileCommand({
        inferenceProfileName: profileName,
        modelSource: { copyFrom: modelArn },
        tags,
      }),
    )

    const profileArn = result.inferenceProfileArn ?? ""
    this.outputChannel.appendLine(`Created inference profile: ${profileArn}`)

    return {
      profileArn,
      modelId,
      tags: Object.fromEntries(tags.map((t) => [t.key!, t.value!])),
    }
  }

  async listFoundationModels(
    region: string,
    awsProfile: string,
  ): Promise<Array<{ modelId: string; modelArn: string }>> {
    const bedrock = new BedrockClient(this.clientConfig(region, awsProfile))
    const result = await bedrock.send(
      new ListFoundationModelsCommand({
        byProvider: "Anthropic",
        byOutputModality: "TEXT",
      }),
    )

    return (result.modelSummaries ?? [])
      .filter((m) => m.modelLifecycle?.status !== "LEGACY")
      .filter((m) => m.modelId && m.modelArn)
      .map((m) => ({
        modelId: m.modelId!,
        // Use cross-region system inference profile ARN — most newer models only
        // support inference via cross-region profiles, not direct on-demand.
        modelArn: m.modelArn!.replace(
          /foundation-model\/anthropic\./,
          "inference-profile/us.anthropic.",
        ),
      }))
  }

  buildModelMap(
    profiles: InferenceProfile[],
    discoveredModelIds: string[],
  ): Record<string, string> {
    const modelMap: Record<string, string> = {}

    for (const profile of profiles) {
      // Profile modelId tag is like "anthropic.claude-sonnet-4-6", discovered IDs are "us.anthropic.claude-sonnet-4-6"
      const crossRegionId = `us.${profile.modelId}`
      if (discoveredModelIds.includes(crossRegionId)) {
        modelMap[crossRegionId] = profile.profileArn
      }
    }

    return modelMap
  }
}

/**
 * Convert a Bedrock model ID (e.g. "us.anthropic.claude-sonnet-4-6" or
 * "anthropic.claude-sonnet-4-5-20250929-v1:0") to a friendly routing name.
 */
export function bedrockIdToFriendlyId(modelId: string): string | null {
  // Strip region prefix: "us.", "global.", "eu.", etc.
  let id = modelId.replace(/^[a-z]+\.(?=anthropic\.)/, "")
  // Strip "anthropic." prefix
  if (!id.startsWith("anthropic.")) return null
  id = id.slice("anthropic.".length)
  // Strip version suffix like "-v1:0", "-v2:0"
  id = id.replace(/-v\d+:\d+$/, "")
  return id
}

/**
 * Generate a profile name following wilma's naming convention:
 * {username}-{abbreviated-model-id}-{6-char-hash} (max 64 chars)
 */
function generateProfileName(userId: string, modelId: string): string {
  // Extract username part (before @)
  const userName = userId.split("@")[0] ?? userId
  const cleanUser = userName.replace(/[^a-z0-9]/gi, "").toLowerCase()

  // Abbreviate model ID segments
  const abbreviated = abbreviateModelId(modelId)

  // Hash for uniqueness
  const hash = createHash("sha256")
    .update(userId + modelId)
    .digest("hex")
    .slice(0, 6)

  const maxContent = 64 - 1 - hash.length // reserve "-" + hash
  let content = `${cleanUser}-${abbreviated}`
  if (content.length > maxContent) {
    content = content.slice(0, maxContent)
  }

  return `${content}-${hash}`.toLowerCase().replace(/[^a-z0-9_-]/g, "")
}

const SEGMENT_ABBREVS: Record<string, string> = {
  anthropic: "ant",
  amazon: "amz",
  claude: "cld",
  sonnet: "snt",
  haiku: "hku",
  opus: "ops",
  titan: "ttn",
  embed: "emb",
  text: "txt",
  nova: "nva",
  lite: "lte",
}

function abbreviateModelId(modelId: string): string {
  return modelId
    .split(/[.\-:]/)
    .filter((s) => s && !/^\d{8}$/.test(s))
    .map((s) => SEGMENT_ABBREVS[s] ?? s)
    .join("")
}
