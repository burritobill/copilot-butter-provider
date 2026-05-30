import * as vscode from "vscode"

import { AnalyzeUsageTool } from "./analyzeUsageTool"
import { BinaryManager } from "./binaryManager"
import { ConfigManager } from "./configManager"
import { CredentialManager } from "./credentialManager"
import { checkForExtensionUpdate } from "./extensionUpdater"
import { InferenceProfileManager } from "./inferenceProfileManager"
import { ProcessManager } from "./processManager"
import { ButterChatModelProvider } from "./provider"
import { RequestLogStore } from "./requestLogStore"
import { StatusBar, showStatusMenu } from "./statusBar"

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("Butter Proxy")
  context.subscriptions.push(outputChannel)

  const binaryManager = new BinaryManager(outputChannel)
  const configManager = new ConfigManager(outputChannel)
  const credentialManager = new CredentialManager(outputChannel)
  const processManager = new ProcessManager(
    binaryManager,
    configManager,
    outputChannel,
    credentialManager,
  )

  context.subscriptions.push({ dispose: () => processManager.dispose() })
  context.subscriptions.push({ dispose: () => credentialManager.dispose() })

  // Capture Butter's structured request-trace logs (stdout) for the
  // analyze-usage tool. Only the window that spawned Butter sees these.
  const logStore = new RequestLogStore()
  context.subscriptions.push({ dispose: () => logStore.dispose() })
  context.subscriptions.push(processManager.onLogChunk((chunk) => logStore.ingestChunk(chunk)))

  const provider = new ButterChatModelProvider(
    () => processManager.getBaseUrl(),
    outputChannel,
    context.globalState,
  )
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("butter", provider))
  context.subscriptions.push({ dispose: () => provider.dispose() })

  // Language model tool Copilot can invoke to analyze usage and suggest
  // agent-instruction improvements.
  context.subscriptions.push(
    vscode.lm.registerTool(
      "butter_analyzeUsage",
      new AnalyzeUsageTool(() => processManager.getBaseUrl(), logStore),
    ),
  )

  // Notify provider when Butter starts/restarts so it re-fetches models
  context.subscriptions.push(
    processManager.onStateChange((state) => {
      if (state === "running") provider.notifyModelsChanged()
    }),
  )

  // Status bar — reflects process + credential state
  const statusBar = new StatusBar()
  context.subscriptions.push({ dispose: () => statusBar.dispose() })

  context.subscriptions.push(
    processManager.onStateChange((state) => statusBar.updateProcessState(state)),
  )
  context.subscriptions.push(
    credentialManager.onCredentialStateChange((state) => statusBar.updateCredentialState(state)),
  )

  const commands: Array<[string, () => void | Promise<void>]> = [
    [
      "butter-copilot.start",
      async () => {
        try {
          await processManager.start()
          vscode.window.showInformationMessage("Butter proxy started")
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          vscode.window.showErrorMessage(`Failed to start Butter: ${msg}`)
        }
      },
    ],
    [
      "butter-copilot.stop",
      async () => {
        await processManager.stop()
        vscode.window.showInformationMessage("Butter proxy stopped")
      },
    ],
    [
      "butter-copilot.restart",
      async () => {
        try {
          await processManager.restart()
          vscode.window.showInformationMessage("Butter proxy restarted")
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          vscode.window.showErrorMessage(`Failed to restart Butter: ${msg}`)
        }
      },
    ],
    ["butter-copilot.showLogs", () => outputChannel.show()],
    [
      "butter-copilot.editConfig",
      async () => {
        const configPath = configManager.getConfigPath()
        await configManager.ensureConfig()
        const doc = await vscode.workspace.openTextDocument(configPath)
        await vscode.window.showTextDocument(doc)
      },
    ],
    [
      "butter-copilot.selectProfile",
      async () => {
        const profile = await credentialManager.selectProfile()
        if (profile !== undefined) {
          await configManager.updateConfig()
          if (processManager.getState() === "running") {
            try {
              await processManager.restart()
              vscode.window.showInformationMessage(
                `Butter restarted with profile: ${profile || "(environment)"}`,
              )
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              vscode.window.showErrorMessage(`Failed to restart Butter: ${msg}`)
            }
          }
        }
      },
    ],
    [
      "butter-copilot.updateBinary",
      async () => {
        try {
          await binaryManager.update()
          vscode.window.showInformationMessage("Butter binary updated successfully")
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          vscode.window.showErrorMessage(`Failed to update Butter: ${msg}`)
        }
      },
    ],
    [
      "butter-copilot.showSettings",
      () => vscode.commands.executeCommand("workbench.action.openSettings", "butter-copilot"),
    ],
    ["butter-copilot.showStatusMenu", () => showStatusMenu(processManager.getState())],
    [
      "butter-copilot.resetConfig",
      async () => {
        await configManager.resetConfig()
        vscode.window.showInformationMessage("Butter config reset to defaults")
        if (processManager.getState() === "running") {
          try {
            await processManager.restart()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            vscode.window.showErrorMessage(`Failed to restart Butter: ${msg}`)
          }
        }
      },
    ],
    [
      "butter-copilot.setupInferenceProfiles",
      async () => {
        const settings = vscode.workspace.getConfiguration("butter-copilot")
        const region = settings.get<string>("awsRegion", "us-west-2")
        const awsProfile = settings.get<string>("awsProfile", "")
        const manager = new InferenceProfileManager(outputChannel)

        try {
          // 1. Detect user identity
          const userId = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Detecting AWS identity..." },
            () => manager.detectUserId(region, awsProfile),
          )
          outputChannel.appendLine(`Detected user: ${userId}`)

          // 2. Prompt for team name (optional)
          const team = await vscode.window.showInputBox({
            title: "Team Name (optional)",
            prompt: "Your team name for cost attribution tagging",
            placeHolder: "e.g. platform, delivery-engineering",
          })
          if (team === undefined) return // cancelled

          // 3. List existing profiles
          const existingProfiles = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Checking existing profiles...",
            },
            () => manager.listUserProfiles(region, awsProfile, userId),
          )

          // 4. Discover available models
          const foundationModels = await manager.listFoundationModels(region, awsProfile)

          // 5. Figure out which models need profiles
          const existingModelIds = new Set(existingProfiles.map((p) => p.modelId))
          const modelsNeedingProfiles = foundationModels.filter(
            (m) => !existingModelIds.has(m.modelId),
          )

          if (modelsNeedingProfiles.length === 0) {
            vscode.window.showInformationMessage(
              `All ${foundationModels.length} models already have inference profiles.`,
            )
          } else {
            // 6. Create profiles for models that don't have them
            const created = await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: "Creating inference profiles...",
                cancellable: false,
              },
              async (progress) => {
                const results = []
                for (const [i, model] of modelsNeedingProfiles.entries()) {
                  progress.report({
                    message: `(${i + 1}/${modelsNeedingProfiles.length}) ${model.modelId}`,
                    increment: 100 / modelsNeedingProfiles.length,
                  })
                  try {
                    const profile = await manager.createProfile(
                      region,
                      awsProfile,
                      userId,
                      team,
                      model.modelArn,
                      model.modelId,
                    )
                    results.push(profile)
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    outputChannel.appendLine(
                      `Failed to create profile for ${model.modelId}: ${msg}`,
                    )
                  }
                }
                return results
              },
            )

            outputChannel.appendLine(`Created ${created.length} inference profiles`)
            vscode.window.showInformationMessage(
              `Created ${created.length} inference profiles (${existingProfiles.length} already existed).`,
            )
          }

          // 7. Enable the setting and regenerate config
          await settings.update("useInferenceProfiles", true, vscode.ConfigurationTarget.Global)
          await configManager.updateConfig()

          if (processManager.getState() === "running") {
            try {
              await processManager.restart()
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              vscode.window.showErrorMessage(`Failed to restart Butter: ${msg}`)
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          vscode.window.showErrorMessage(`Inference profile setup failed: ${msg}`)
        }
      },
    ],
    [
      "butter-copilot.showStatus",
      () => {
        const state = processManager.getState()
        const credState = credentialManager.getCredentialState()
        const profile =
          vscode.workspace.getConfiguration("butter-copilot").get<string>("awsProfile", "") ||
          "(environment)"
        vscode.window.showInformationMessage(
          `Butter: ${state} | Credentials: ${credState} | Profile: ${profile}`,
        )
      },
    ],
  ]

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler))
  }

  // Ensure the binary is available eagerly (fast, no AWS auth required).
  // Credential validation and Butter startup are deferred until the user
  // actually selects a Butter model so we don't trigger SSO / STS calls
  // just because VS Code loaded the extension.
  binaryManager.ensureBinary().then(
    () => void binaryManager.checkForUpdate(),
    (err) => outputChannel.appendLine(`Failed to ensure Butter binary: ${err}`),
  )

  // Check for extension updates (silent on failure)
  checkForExtensionUpdate(outputChannel).catch(() => {})

  // Lazy start: validate credentials and spawn Butter on first use.
  let startPromise: Promise<void> | null = null
  const ensureRunning = (): Promise<void> => {
    if (processManager.getState() === "running") return Promise.resolve()
    if (startPromise) return startPromise
    startPromise = (async () => {
      const mode = vscode.workspace
        .getConfiguration("butter-copilot")
        .get<string>("mode", "managed")
      if (mode === "managed") {
        const validation = await credentialManager.validateCredentials()
        if (!validation.valid) {
          outputChannel.appendLine(`Credential warning: ${validation.message}`)
          await credentialManager.handleAuthFailure()
        }
      }
      try {
        await processManager.start()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        outputChannel.appendLine(`Failed to start Butter: ${msg}`)
      } finally {
        startPromise = null
      }
    })()
    return startPromise
  }

  provider.onFirstUse(ensureRunning)
}

export function deactivate() {}
