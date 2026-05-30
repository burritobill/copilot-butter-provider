import { execFile as execFileCb } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { arch, homedir, platform } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import * as vscode from "vscode"

const execFile = promisify(execFileCb)

const GITHUB_RELEASES_API = "https://api.github.com/repos/temikus/butter/releases/latest"
const BASE_DIR = join(homedir(), ".butter-copilot")
const BIN_DIR = join(BASE_DIR, "bin")
const VERSION_FILE = join(BASE_DIR, "version.json")

interface VersionInfo {
  version: string
  downloadedAt: string
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GitHubRelease {
  tag_name: string
  assets: ReleaseAsset[]
}

export function getAssetName(version: string): string {
  const os = platform() === "darwin" ? "darwin" : "linux"
  const cpu = arch() === "arm64" ? "arm64" : "amd64"
  return `butter_${version}_${os}_${cpu}.tar.gz`
}

export class BinaryManager {
  private outputChannel: vscode.OutputChannel

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel
  }

  getBinaryPath(): string {
    const customPath = vscode.workspace
      .getConfiguration("butter-copilot")
      .get<string>("butterBinaryPath", "")
    return customPath || join(BIN_DIR, "butter")
  }

  async isInstalled(): Promise<boolean> {
    const { access } = await import("node:fs/promises")
    try {
      await access(this.getBinaryPath())
      return true
    } catch {
      return false
    }
  }

  async getInstalledVersion(): Promise<string | undefined> {
    try {
      const data = await readFile(VERSION_FILE, "utf-8")
      const info: VersionInfo = JSON.parse(data)
      return info.version
    } catch {
      return undefined
    }
  }

  async fetchLatestRelease(): Promise<GitHubRelease> {
    const response = await fetch(GITHUB_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
    }
    return response.json() as Promise<GitHubRelease>
  }

  async ensureBinary(): Promise<string> {
    const binaryPath = this.getBinaryPath()
    if (await this.isInstalled()) {
      this.outputChannel.appendLine(`Butter binary found at ${binaryPath}`)
      return binaryPath
    }

    return this.downloadWithProgress("Downloading Butter...")
  }

  async update(): Promise<string> {
    return this.downloadWithProgress("Updating Butter...")
  }

  async checkForUpdate(): Promise<void> {
    try {
      const installed = await this.getInstalledVersion()
      if (!installed) return

      const release = await this.fetchLatestRelease()
      const latest = release.tag_name.replace(/^v/, "")
      if (installed === latest) return

      const action = await vscode.window.showInformationMessage(
        `Butter ${latest} is available (installed: ${installed})`,
        "Update",
      )
      if (action === "Update") {
        await this.update()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`Update check failed: ${msg}`)
    }
  }

  private async downloadWithProgress(message: string): Promise<string> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Butter for Copilot",
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: "Fetching latest release..." })
        const release = await this.fetchLatestRelease()
        if (token.isCancellationRequested) throw new Error("Cancelled")

        await this.downloadRelease(release, progress, token)
        return this.getBinaryPath()
      },
    )
  }

  private async downloadRelease(
    release: GitHubRelease,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const version = release.tag_name.replace(/^v/, "")
    const assetName = getAssetName(version)
    const asset = release.assets.find((a) => a.name === assetName)
    if (!asset) {
      const supported = release.assets.map((a) => a.name).join(", ")
      throw new Error(
        `No binary for ${platform()}/${arch()}. Expected: ${assetName}. Available: ${supported}`,
      )
    }

    const checksumsAsset = release.assets.find((a) => a.name === "checksums.txt")

    this.outputChannel.appendLine(`Downloading ${assetName}...`)
    progress.report({ message: `Downloading Butter ${version}...` })

    await mkdir(BIN_DIR, { recursive: true })
    const tarPath = join(BASE_DIR, assetName)

    // Download tarball
    const response = await fetch(asset.browser_download_url)
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    if (token.isCancellationRequested) throw new Error("Cancelled")

    await writeFile(tarPath, Buffer.from(arrayBuffer))

    // Verify checksum
    if (checksumsAsset) {
      progress.report({ message: "Verifying checksum..." })
      await this.verifyChecksum(tarPath, assetName, checksumsAsset.browser_download_url)
    }

    // Extract and install
    progress.report({ message: "Extracting..." })
    await execFile("tar", ["xzf", tarPath, "-C", BIN_DIR])
    await chmod(join(BIN_DIR, "butter"), 0o755)
    await unlink(tarPath).catch(() => {})

    // Save version metadata
    const versionInfo: VersionInfo = { version, downloadedAt: new Date().toISOString() }
    await writeFile(VERSION_FILE, JSON.stringify(versionInfo, null, 2))

    this.outputChannel.appendLine(`Installed Butter ${version} to ${BIN_DIR}`)
    progress.report({ message: `Butter ${version} installed` })
  }

  private async verifyChecksum(
    filePath: string,
    assetName: string,
    checksumsUrl: string,
  ): Promise<void> {
    const response = await fetch(checksumsUrl)
    if (!response.ok) {
      this.outputChannel.appendLine("Warning: Could not download checksums, skipping verification")
      return
    }

    const checksumsText = await response.text()
    const expectedHash = parseChecksumForAsset(checksumsText, assetName)
    if (!expectedHash) {
      this.outputChannel.appendLine(`Warning: No checksum found for ${assetName}`)
      return
    }

    const fileData = await readFile(filePath)
    const actualHash = createHash("sha256").update(fileData).digest("hex")

    if (actualHash !== expectedHash) {
      throw new Error(
        `Checksum mismatch for ${assetName}:\n  expected: ${expectedHash}\n  got:      ${actualHash}`,
      )
    }

    this.outputChannel.appendLine(`Checksum verified for ${assetName}`)
  }
}

export function parseChecksumForAsset(
  checksumsText: string,
  assetName: string,
): string | undefined {
  const line = checksumsText.split("\n").find((l) => l.includes(assetName))
  return line?.split(/\s+/)[0]
}
