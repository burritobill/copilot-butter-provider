import * as vscode from "vscode"

import type { CredentialState } from "./credentialManager"
import type { ProcessState } from "./processManager"

interface StatusBarState {
  processState: ProcessState
  credentialState: CredentialState
  modelCount?: number
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem
  private currentState: StatusBarState = {
    processState: "stopped",
    credentialState: "unchecked",
  }

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.item.command = "butter-copilot.showStatusMenu"
    this.render()
    this.item.show()
  }

  updateProcessState(state: ProcessState): void {
    this.currentState.processState = state
    this.render()
  }

  updateCredentialState(state: CredentialState): void {
    this.currentState.credentialState = state
    this.render()
  }

  updateModelCount(count: number): void {
    this.currentState.modelCount = count
    this.render()
  }

  private render(): void {
    const { processState, credentialState, modelCount } = this.currentState

    // Credential issues take priority over process state
    if (credentialState === "expired") {
      this.item.text = "$(lock) Butter: Auth Required"
      this.item.tooltip = "AWS credentials expired — click for options"
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
      return
    }

    switch (processState) {
      case "running": {
        const models = modelCount !== undefined ? ` (${modelCount} models)` : ""
        this.item.text = `$(symbol-field) Butter: Running${models}`
        this.item.tooltip = "Butter proxy is running — click for options"
        this.item.backgroundColor = undefined
        break
      }

      case "starting": {
        this.item.text = "$(sync~spin) Butter: Starting..."
        this.item.tooltip = "Butter proxy is starting up"
        this.item.backgroundColor = undefined
        break
      }

      case "error": {
        this.item.text = "$(error) Butter: Error"
        this.item.tooltip = "Butter proxy encountered an error — click for options"
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
        break
      }

      case "stopped": {
        this.item.text = "$(circle-slash) Butter: Idle"
        this.item.tooltip = "Butter starts automatically when you use a Butter model"
        this.item.backgroundColor = undefined
        break
      }
    }
  }

  dispose(): void {
    this.item.dispose()
  }
}

/**
 * Show a quick pick menu with status bar actions.
 */
export async function showStatusMenu(processState: ProcessState): Promise<void> {
  const items: vscode.QuickPickItem[] = []

  if (processState === "running") {
    items.push(
      { label: "$(debug-stop) Stop Proxy", description: "Stop the Butter process" },
      { label: "$(debug-restart) Restart Proxy", description: "Restart the Butter process" },
    )
  } else {
    items.push({
      label: "$(play) Start Proxy",
      description: "Start the Butter process",
    })
  }

  items.push(
    { label: "$(output) View Logs", description: "Open the Butter output channel" },
    { label: "$(edit) Edit Config", description: "Open Butter config file" },
    { label: "$(key) Select AWS Profile", description: "Choose an AWS profile" },
    { label: "$(cloud-download) Update Binary", description: "Download latest Butter release" },
    { label: "$(settings-gear) Settings", description: "Open Butter settings" },
  )

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Butter Proxy",
  })

  if (!selected) return

  const label = selected.label
  if (label.includes("Start")) {
    await vscode.commands.executeCommand("butter-copilot.start")
  } else if (label.includes("Stop")) {
    await vscode.commands.executeCommand("butter-copilot.stop")
  } else if (label.includes("Restart")) {
    await vscode.commands.executeCommand("butter-copilot.restart")
  } else if (label.includes("View Logs")) {
    await vscode.commands.executeCommand("butter-copilot.showLogs")
  } else if (label.includes("Edit Config")) {
    await vscode.commands.executeCommand("butter-copilot.editConfig")
  } else if (label.includes("AWS Profile")) {
    await vscode.commands.executeCommand("butter-copilot.selectProfile")
  } else if (label.includes("Update Binary")) {
    await vscode.commands.executeCommand("butter-copilot.updateBinary")
  } else if (label.includes("Settings")) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "butter-copilot")
  }
}
