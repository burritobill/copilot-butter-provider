import * as vscode from "vscode"

import type { AnthropicMessage } from "./messageConverter"
import { convertAnthropicTools, convertToAnthropicMessages } from "./messageConverter"
import { fetchModels, modelToInfo } from "./modelInfo"
import type { AnthropicMessagesRequest } from "./streamHandler"
import { CountTokensError, countTokens, streamAnthropicMessages } from "./streamHandler"

/** globalState key persisting the last Butter model the user actually used. */
const LAST_MODEL_KEY = "butter-copilot.lastUsedModel"
/** globalState key persisting the known model ID list across restarts. */
const KNOWN_MODELS_KEY = "butter-copilot.knownModelIds"

/**
 * ButterChatModelProvider — implements VS Code's LanguageModelChatProvider.
 * Connects to Butter's OpenAI-compatible API for Bedrock models.
 */
export class ButterChatModelProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event

  private cachedModels: vscode.LanguageModelChatInformation[] | null = null

  // When the count_tokens endpoint is denied (403), stop calling it for the
  // rest of the session and fall back to the heuristic, so we don't repeatedly
  // hit a known-denied endpoint on every keystroke.
  private countTokensDisabled = false

  // Lazy-start hook: called before chat requests to ensure Butter is running.
  // Defers AWS credentials + process spawn until the user actually picks a
  // Butter model, rather than on VS Code startup.
  private ensureRunningHook: (() => Promise<void>) | null = null

  constructor(
    private readonly getBaseUrl: () => string,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly memento?: vscode.Memento,
  ) {}

  /**
   * Register a callback that will be invoked before each chat request to
   * ensure Butter is running. The callback should be a no-op if Butter is
   * already running.
   */
  onFirstUse(hook: () => Promise<void>): void {
    this.ensureRunningHook = hook
  }

  private async triggerLazyStart(): Promise<void> {
    if (!this.ensureRunningHook) return
    await this.ensureRunningHook()
  }

  /**
   * Signal that models have changed (e.g. after config change or Butter restart).
   */
  notifyModelsChanged(): void {
    // Intentionally keep `cachedModels` so that if the post-restart re-fetch
    // races Butter's port binding and fails, we still serve the last known-good
    // model list (with the persisted default) instead of collapsing to a single
    // hardcoded fallback — which makes VS Code reset the picker to "auto".
    this.onDidChangeEmitter.fire()
  }

  async provideLanguageModelChatInformation(
    _options: { configuration?: Record<string, unknown> },
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const baseUrl = this.getBaseUrl()

    try {
      const modelIds = await fetchModels(baseUrl)
      this.cachedModels = this.applyDefault(modelIds.map(modelToInfo))
      this.outputChannel.appendLine(`Discovered ${this.cachedModels.length} models from Butter`)
      // Persist the model ID list so cold starts show the full set.
      void this.memento?.update(KNOWN_MODELS_KEY, modelIds)
      return this.cachedModels
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`Failed to fetch models from Butter: ${msg}`)

      // Return cached models if available (warm restart / re-fetch race).
      if (this.cachedModels) return this.cachedModels

      // Cold start: rebuild from persisted model IDs so the full set is
      // available in the picker even before Butter is running.
      const persistedIds = this.memento?.get<string[]>(KNOWN_MODELS_KEY)
      if (persistedIds && persistedIds.length > 0) {
        this.cachedModels = this.applyDefault(persistedIds.map(modelToInfo))
        return this.cachedModels
      }

      // Last resort: single fallback from the last-used model.
      const fallbackId = this.memento?.get<string>(LAST_MODEL_KEY) ?? "claude-sonnet-4-20250514"
      return this.applyDefault([modelToInfo(fallbackId)])
    }
  }

  /**
   * Mark the user's last-used Butter model as the default so the chat model
   * picker re-selects it after a restart instead of falling back to "auto".
   * Falls back to the first model if no prior selection is recorded.
   */
  private applyDefault(
    models: vscode.LanguageModelChatInformation[],
  ): vscode.LanguageModelChatInformation[] {
    if (models.length === 0) return models
    const lastUsed = this.memento?.get<string>(LAST_MODEL_KEY)
    const defaultId = lastUsed && models.some((m) => m.id === lastUsed) ? lastUsed : models[0]!.id
    return models.map((m) => ({ ...m, isDefault: m.id === defaultId }))
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // Lazily start Butter + validate AWS creds on first actual chat request.
    await this.triggerLazyStart()

    const baseUrl = this.getBaseUrl()

    // Remember the model the user actually used so we can re-default to it
    // after a restart instead of letting the picker fall back to "auto".
    void this.memento?.update(LAST_MODEL_KEY, model.id)

    const { messages: anthropicMessages } = convertToAnthropicMessages(messages)

    const request: AnthropicMessagesRequest = {
      model: model.id,
      max_tokens: 8192,
      anthropic_version: "bedrock-2023-05-31",
      messages: anthropicMessages,
      stream: true,
    }

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      request.tools = convertAnthropicTools(options.tools)
      request.tool_choice =
        options.toolMode === vscode.LanguageModelChatToolMode.Required
          ? { type: "any" }
          : { type: "auto" }
    }

    this.outputChannel.appendLine(
      `Chat request: model=${model.id}, messages=${messages.length}, tools=${options.tools?.length ?? 0}`,
    )

    const usage = await streamAnthropicMessages(baseUrl, request, progress, token)

    // Emit usage stats as a LanguageModelDataPart so VS Code's context-window
    // gauge can display token counts for BYOK models.
    if (usage) {
      const usageData = new TextEncoder().encode(JSON.stringify(usage))
      ;(progress as unknown as vscode.Progress<vscode.LanguageModelDataPart>).report(
        new vscode.LanguageModelDataPart(usageData, "usage"),
      )
    }
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    // Prefer Butter's native count_tokens endpoint for an accurate count.
    // Fall back to a ~4 chars/token heuristic if it is unavailable.
    if (!this.countTokensDisabled) {
      const message = toCountMessage(text)
      try {
        const count = await countTokens(this.getBaseUrl(), model.id, [message], token)
        if (count !== undefined) return count
      } catch (err) {
        if (err instanceof CountTokensError && err.status === 403) {
          this.handleCountTokensDenied(err)
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          this.outputChannel.appendLine(`count_tokens failed, using heuristic: ${msg}`)
        }
      }
    }
    return estimateTokens(text)
  }

  /**
   * Handle a 403 from the count_tokens endpoint: disable the endpoint for the
   * session (heuristic fallback continues to work) and surface a one-time
   * notification explaining the missing IAM permission.
   */
  private handleCountTokensDenied(err: CountTokensError): void {
    this.countTokensDisabled = true
    this.outputChannel.appendLine(
      `count_tokens denied (403); using token estimate for the rest of this session. ` +
        `Grant the IAM action 'bedrock-mantle:CountTokens' to enable accurate counts. Response: ${err.body}`,
    )
    void vscode.window
      .showWarningMessage(
        "Butter: accurate token counting is disabled because your AWS role lacks the " +
          "'bedrock-mantle:CountTokens' permission. Context usage will use an estimate instead.",
        "Show Logs",
      )
      .then((choice) => {
        if (choice === "Show Logs") this.outputChannel.show()
      })
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose()
  }
}

/**
 * Convert the `provideTokenCount` argument (a raw string or a single chat
 * message) into an Anthropic message for the count_tokens endpoint. Strings
 * and non-user messages are wrapped as a user message, since count_tokens
 * requires the final message to be from the user.
 */
function toCountMessage(text: string | vscode.LanguageModelChatRequestMessage): AnthropicMessage {
  if (typeof text === "string") {
    return { role: "user", content: text }
  }
  const { messages } = convertToAnthropicMessages([text])
  const converted = messages[0]
  if (converted && converted.role === "user") {
    return converted
  }
  // Re-home assistant/tool content under a user role so count_tokens accepts it.
  return { role: "user", content: converted?.content ?? "" }
}

/**
 * Heuristic fallback when the count_tokens endpoint is unavailable:
 * ~4 chars per token across all content parts.
 */
function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
  if (typeof text === "string") {
    return Math.ceil(text.length / 4)
  }
  let totalChars = 0
  const content = text.content
  if (Array.isArray(content)) {
    for (const part of content) {
      totalChars += estimatePartChars(part)
    }
  }
  // Defensive fallback: if the structured walk produced nothing (e.g. an
  // unexpected message shape from the proposed API, where `content` is empty
  // or its parts don't match the known classes), serialize the whole message
  // so the gauge never collapses to 0 for a non-empty message.
  if (totalChars === 0) {
    totalChars = safeJsonLength(text)
  }
  return Math.ceil(totalChars / 4)
}

/**
 * Estimate the character count of a single message content part for token
 * counting. Covers text, tool calls, tool results, and binary data parts so
 * that VS Code's context-usage gauge reflects the full conversation, not just
 * plain text.
 */
function estimatePartChars(part: unknown): number {
  if (isInstanceOf(part, vscode.LanguageModelTextPart)) {
    return (part as vscode.LanguageModelTextPart).value.length
  }

  if (isInstanceOf(part, vscode.LanguageModelToolCallPart)) {
    // Name plus serialized arguments.
    const p = part as vscode.LanguageModelToolCallPart
    return p.name.length + safeJsonLength(p.input)
  }

  if (isInstanceOf(part, vscode.LanguageModelToolResultPart)) {
    let chars = 0
    for (const content of (part as vscode.LanguageModelToolResultPart).content) {
      if (isInstanceOf(content, vscode.LanguageModelTextPart)) {
        chars += (content as vscode.LanguageModelTextPart).value.length
      } else {
        chars += safeJsonLength(content)
      }
    }
    return chars
  }

  if (isInstanceOf(part, vscode.LanguageModelDataPart)) {
    // Binary payloads (e.g. images). Use the byte length as a rough proxy.
    return (part as vscode.LanguageModelDataPart).data.byteLength
  }

  // Unknown part type — fall back to its serialized size.
  return safeJsonLength(part)
}

/**
 * Guarded `instanceof` — some part classes are proposed APIs that may be
 * undefined at runtime (or absent in tests). Avoids throwing on
 * `instanceof undefined`.
 */
function isInstanceOf(
  value: unknown,
  ctor: (new (...args: never[]) => unknown) | undefined,
): boolean {
  return typeof ctor === "function" && value instanceof ctor
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}
