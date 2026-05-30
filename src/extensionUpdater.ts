import * as vscode from "vscode"

const GITHUB_RELEASES_API =
  "https://api.github.com/repos/burritobill/copilot-butter-provider/releases/latest"

export interface GitHubAsset {
  name: string
  browser_download_url: string
}

export interface GitHubRelease {
  tag_name: string
  assets: GitHubAsset[]
}

/** Returns the .vsix asset if an update is available, or undefined if up-to-date / no asset. */
export function resolveUpdate(
  currentVersion: string,
  release: GitHubRelease,
): { latest: string; vsixAsset: GitHubAsset } | undefined {
  const latest = release.tag_name.replace(/^v/, "")
  if (latest === currentVersion) return undefined
  const vsixAsset = release.assets.find((a) => a.name.endsWith(".vsix"))
  if (!vsixAsset) return undefined
  return { latest, vsixAsset }
}

export async function checkForExtensionUpdate(outputChannel: vscode.OutputChannel): Promise<void> {
  const ext = vscode.extensions.getExtension("burritobill.butter-copilot")
  if (!ext) return

  const currentVersion: string = ext.packageJSON.version

  let release: GitHubRelease
  try {
    const response = await fetch(GITHUB_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!response.ok) return
    release = (await response.json()) as GitHubRelease
  } catch {
    return // Silent fail — network issues shouldn't bother the user
  }

  const update = resolveUpdate(currentVersion, release)
  if (!update) return

  const { latest, vsixAsset } = update

  outputChannel.appendLine(`Extension update available: ${currentVersion} → ${latest}`)

  const action = await vscode.window.showInformationMessage(
    `Butter for Copilot ${latest} is available (installed: ${currentVersion})`,
    "Update",
    "Release Notes",
  )

  if (action === "Update") {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Updating Butter for Copilot…",
      },
      async () => {
        try {
          const response = await fetch(vsixAsset.browser_download_url)
          if (!response.ok) throw new Error(`Download failed: ${response.status}`)

          const buffer = await response.arrayBuffer()
          const tmpUri = vscode.Uri.joinPath(
            vscode.Uri.file(require("os").tmpdir()),
            vsixAsset.name,
          )
          await vscode.workspace.fs.writeFile(tmpUri, new Uint8Array(buffer))

          await vscode.commands.executeCommand("workbench.extensions.installExtension", tmpUri)
          const reload = await vscode.window.showInformationMessage(
            `Butter for Copilot updated to ${latest}. Reload to activate.`,
            "Reload",
          )
          if (reload === "Reload") {
            await vscode.commands.executeCommand("workbench.action.reloadWindow")
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          vscode.window.showErrorMessage(`Extension update failed: ${msg}`)
        }
      },
    )
  } else if (action === "Release Notes") {
    vscode.env.openExternal(
      vscode.Uri.parse(
        `https://github.com/burritobill/copilot-butter-provider/releases/tag/v${latest}`,
      ),
    )
  }
}
