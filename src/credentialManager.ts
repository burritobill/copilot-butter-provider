import { execFile as execFileCb } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts"
import { fromIni } from "@aws-sdk/credential-providers"
import * as vscode from "vscode"

const execFile = promisify(execFileCb)

export type ProfileType =
  | "credential_process"
  | "sso"
  | "assume_role"
  | "static"
  | "environment"
  | "unknown"

export interface AwsProfile {
  name: string
  type: ProfileType
  fields: Record<string, string>
}

export type CredentialState = "valid" | "expired" | "unknown" | "unchecked"

const AUTH_ERROR_PATTERNS = [
  /ExpiredToken/i,
  /InvalidSignatureException/i,
  /SignatureDoesNotMatch/i,
  /UnrecognizedClientException/i,
  /AccessDeniedException/i,
  /IncompleteSignature/i,
  /The security token included in the request is expired/i,
  /The security token included in the request is invalid/i,
  /credential/i,
  /\b403\b.*(?:forbidden|unauthorized)/i,
]

export class CredentialManager {
  private credentialState: CredentialState = "unchecked"
  private currentProfileType: ProfileType = "unknown"

  private readonly onCredentialStateChangeEmitter = new vscode.EventEmitter<CredentialState>()
  readonly onCredentialStateChange = this.onCredentialStateChangeEmitter.event

  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  getCredentialState(): CredentialState {
    return this.credentialState
  }

  getCurrentProfileType(): ProfileType {
    return this.currentProfileType
  }

  /**
   * Parse ~/.aws/config and return available profiles with detected types.
   */
  async listProfiles(): Promise<AwsProfile[]> {
    const configPath = join(homedir(), ".aws", "config")
    let content: string
    try {
      content = await readFile(configPath, "utf-8")
    } catch {
      this.outputChannel.appendLine("No ~/.aws/config found")
      return []
    }

    return parseAwsConfig(content)
  }

  /**
   * Show a QuickPick for the user to select an AWS profile.
   * Returns the selected profile name, or undefined if cancelled.
   */
  async selectProfile(): Promise<string | undefined> {
    const profiles = await this.listProfiles()

    const items: vscode.QuickPickItem[] = [
      {
        label: "$(globe) None (use environment)",
        description: "Use AWS_* environment variables",
        detail: "environment",
      },
      ...profiles.map((p) => ({
        label: p.name,
        description: describeProfileType(p.type),
        detail: p.name,
      })),
    ]

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select an AWS profile for Bedrock access",
      title: "AWS Profile",
    })

    if (!selected) return undefined

    const profileName = selected.detail === "environment" ? "" : selected.detail!
    const config = vscode.workspace.getConfiguration("butter-copilot")
    await config.update("awsProfile", profileName, vscode.ConfigurationTarget.Global)

    this.currentProfileType =
      profileName === ""
        ? "environment"
        : (profiles.find((p) => p.name === profileName)?.type ?? "unknown")

    this.outputChannel.appendLine(
      profileName
        ? `Selected AWS profile: ${profileName} (${describeProfileType(this.currentProfileType)})`
        : "Using environment credentials (no profile)",
    )

    return profileName
  }

  /**
   * Detect the type of the currently configured profile.
   */
  async detectCurrentProfileType(): Promise<ProfileType> {
    const profileName = vscode.workspace
      .getConfiguration("butter-copilot")
      .get<string>("awsProfile", "")

    if (!profileName) {
      this.currentProfileType = "environment"
      return "environment"
    }

    const profiles = await this.listProfiles()
    const profile = profiles.find((p) => p.name === profileName)
    this.currentProfileType = profile?.type ?? "unknown"
    return this.currentProfileType
  }

  /**
   * Check stderr output for AWS auth errors. Call this with each chunk of stderr.
   * Returns true if an auth error was detected.
   */
  checkForAuthError(stderrChunk: string): boolean {
    const isAuthError = AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(stderrChunk))
    if (isAuthError) {
      this.setCredentialState("expired")
      return true
    }
    return false
  }

  /**
   * Handle an auth failure — show appropriate recovery UI based on profile type.
   */
  async handleAuthFailure(): Promise<void> {
    const profileName = vscode.workspace
      .getConfiguration("butter-copilot")
      .get<string>("awsProfile", "")

    await this.detectCurrentProfileType()

    switch (this.currentProfileType) {
      case "credential_process": {
        const autoLoginEnabled = await this.isGrantedAutoLoginEnabled()
        if (autoLoginEnabled) {
          // Auto-login is enabled — Granted will handle auth when Butter starts
          this.outputChannel.appendLine(
            "Granted auto-login is enabled — credentials will refresh automatically",
          )
          this.setCredentialState("valid")
          break
        }
        const action = await vscode.window.showWarningMessage(
          "AWS credential process failed. Enable Granted auto-login to authenticate automatically.",
          "Enable Auto-Login",
          "Login Manually",
          "View Logs",
        )
        if (action === "Enable Auto-Login") {
          await this.enableGrantedAutoLogin()
          this.setCredentialState("valid")
        } else if (action === "Login Manually") {
          await this.runSsoLogin(profileName)
        } else if (action === "View Logs") {
          this.outputChannel.show()
        }
        break
      }

      case "sso": {
        const action = await vscode.window.showWarningMessage(
          "AWS SSO session expired.",
          "Login",
          "View Logs",
        )
        if (action === "Login") {
          await this.runSsoLogin(profileName)
        } else if (action === "View Logs") {
          this.outputChannel.show()
        }
        break
      }

      case "environment": {
        await vscode.window.showWarningMessage(
          "AWS credentials expired. Refresh your environment credentials and restart VS Code.",
        )
        break
      }

      case "static": {
        await vscode.window.showErrorMessage(
          "AWS credential error. Check your access key and secret in the configured profile.",
        )
        break
      }

      case "assume_role": {
        const action = await vscode.window.showWarningMessage(
          "AWS assume-role credentials expired. The source profile credentials may need refreshing.",
          "View Logs",
        )
        if (action === "View Logs") this.outputChannel.show()
        break
      }

      default: {
        const action = await vscode.window.showWarningMessage(
          "AWS authentication error detected. Check your credentials.",
          "View Logs",
        )
        if (action === "View Logs") this.outputChannel.show()
      }
    }
  }

  /**
   * Run SSO login in the background, opening the auth URL in VS Code's Simple Browser.
   * Shows a progress notification while waiting for the user to complete auth.
   */
  async runSsoLogin(profileName: string): Promise<boolean> {
    const loginArgs = await this.buildLoginArgs(profileName)

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Waiting for AWS SSO authentication...",
        cancellable: true,
      },
      async (_progress, token) => {
        try {
          const child = execFileCb(loginArgs[0]!, loginArgs.slice(1))
          token.onCancellationRequested(() => child.kill())

          // Log output from the login process
          const onData = (data: Buffer) => {
            this.outputChannel.appendLine(data.toString().trimEnd())
          }
          child.stdout?.on("data", onData)
          child.stderr?.on("data", onData)

          await new Promise<void>((resolve, reject) => {
            child.on("close", (code) => {
              if (code === 0) resolve()
              else reject(new Error(`Login exited with code ${code}`))
            })
            child.on("error", reject)
          })

          this.setCredentialState("valid")
          vscode.window.showInformationMessage("AWS SSO login successful")
          this.outputChannel.appendLine("AWS SSO login completed successfully")
          return true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          this.outputChannel.appendLine(`AWS SSO login failed: ${msg}`)
          vscode.window.showErrorMessage(`AWS SSO login failed: ${msg}`)
          return false
        }
      },
    )
  }

  /**
   * Lightweight credential validation before starting Butter.
   * Does not block — returns validation result for the caller to act on.
   */
  async validateCredentials(): Promise<{ valid: boolean; message?: string }> {
    const profileName = vscode.workspace
      .getConfiguration("butter-copilot")
      .get<string>("awsProfile", "")

    await this.detectCurrentProfileType()

    // Quick pre-check for environment profiles with no env vars set
    if (this.currentProfileType === "environment") {
      const hasKey = Boolean(process.env.AWS_ACCESS_KEY_ID)
      if (!hasKey) {
        return {
          valid: false,
          message:
            "No AWS credentials found in environment. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or configure an AWS profile.",
        }
      }
    }

    // Actually test credentials with sts get-caller-identity
    try {
      const sts = new STSClient({
        region: vscode.workspace
          .getConfiguration("butter-copilot")
          .get<string>("awsRegion", "us-west-2"),
        ...(profileName ? { credentials: fromIni({ profile: profileName }) } : {}),
      })
      await sts.send(new GetCallerIdentityCommand({}))
      this.setCredentialState("valid")
      return { valid: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`Credential validation failed: ${msg}`)

      // Provide profile-type-specific guidance
      const hint = this.getAuthHint(profileName)
      this.setCredentialState("expired")
      return { valid: false, message: hint }
    }
  }

  private getAuthHint(profileName: string): string {
    switch (this.currentProfileType) {
      case "sso":
        return `AWS SSO session expired. Run: aws sso login --profile ${profileName}`
      case "credential_process":
        return `AWS credential process failed for profile "${profileName}". You may need to re-authenticate (e.g. granted sso login).`
      case "assume_role":
        return `AWS assume-role credentials expired for profile "${profileName}". Refresh the source profile credentials.`
      case "static":
        return `AWS credential error for profile "${profileName}". Check your access key and secret.`
      case "environment":
        return "AWS environment credentials expired. Refresh them and restart VS Code."
      default:
        return `AWS credentials invalid for profile "${profileName}". Check your configuration.`
    }
  }

  /**
   * Build the login command args for the given profile.
   * For Granted profiles, uses granted_sso_start_url/granted_sso_region fields.
   * For native SSO profiles, uses aws sso login --profile.
   */
  private async buildLoginArgs(profileName: string): Promise<string[]> {
    const profiles = await this.listProfiles()
    const profile = profiles.find((p) => p.name === profileName)

    if (profile) {
      const startUrl = profile.fields.granted_sso_start_url ?? profile.fields.sso_start_url
      const ssoRegion = profile.fields.granted_sso_region ?? profile.fields.sso_region
      if (startUrl && ssoRegion) {
        return ["granted", "sso", "login", "--sso-start-url", startUrl, "--sso-region", ssoRegion]
      }
    }

    return ["aws", "sso", "login", "--profile", profileName]
  }

  /**
   * Check if Granted's CredentialProcessAutoLogin setting is enabled.
   */
  private async isGrantedAutoLoginEnabled(): Promise<boolean> {
    try {
      const configPath = join(homedir(), ".granted", "config")
      const content = await readFile(configPath, "utf-8")
      return /CredentialProcessAutoLogin\s*=\s*true/i.test(content)
    } catch {
      return false
    }
  }

  /**
   * Enable Granted's CredentialProcessAutoLogin setting.
   */
  private async enableGrantedAutoLogin(): Promise<void> {
    try {
      await execFile("granted", [
        "settings",
        "set",
        "--setting=CredentialProcessAutoLogin",
        "--value",
        "true",
      ])
      this.outputChannel.appendLine("Enabled Granted CredentialProcessAutoLogin")
      vscode.window.showInformationMessage(
        "Granted auto-login enabled. Credentials will refresh automatically when needed.",
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.outputChannel.appendLine(`Failed to enable Granted auto-login: ${msg}`)
      vscode.window.showErrorMessage(`Failed to enable auto-login: ${msg}`)
    }
  }

  setCredentialState(state: CredentialState): void {
    if (this.credentialState !== state) {
      this.credentialState = state
      this.onCredentialStateChangeEmitter.fire(state)
    }
  }

  dispose(): void {
    this.onCredentialStateChangeEmitter.dispose()
  }
}

/**
 * Parse an AWS config file into profile entries with detected types.
 */
export function parseAwsConfig(content: string): AwsProfile[] {
  const profiles: AwsProfile[] = []
  let currentProfile: { name: string; fields: Record<string, string> } | null = null

  for (const line of content.split("\n")) {
    const trimmed = line.trim()

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue

    // Profile header: [profile name] or [default]
    const profileMatch = trimmed.match(/^\[(?:profile\s+)?(.+?)\]$/)
    if (profileMatch) {
      if (currentProfile) {
        profiles.push({
          name: currentProfile.name,
          type: detectProfileType(currentProfile.fields),
          fields: currentProfile.fields,
        })
      }
      currentProfile = { name: profileMatch[1]!, fields: {} }
      continue
    }

    // Key = value
    if (currentProfile) {
      const kvMatch = trimmed.match(/^(\S+)\s*=\s*(.*)$/)
      if (kvMatch) {
        currentProfile.fields[kvMatch[1]!] = kvMatch[2]!.trim()
      }
    }
  }

  // Don't forget the last profile
  if (currentProfile) {
    profiles.push({
      name: currentProfile.name,
      type: detectProfileType(currentProfile.fields),
      fields: currentProfile.fields,
    })
  }

  return profiles
}

/**
 * Detect the auth type of a profile based on its config fields.
 */
export function detectProfileType(fields: Record<string, string>): ProfileType {
  if (fields.credential_process) return "credential_process"
  if (fields.sso_session || fields.sso_start_url) return "sso"
  if (fields.role_arn && fields.source_profile) return "assume_role"
  if (fields.aws_access_key_id) return "static"
  return "unknown"
}

function describeProfileType(type: ProfileType): string {
  switch (type) {
    case "credential_process":
      return "Credential Process (e.g. Granted)"
    case "sso":
      return "AWS SSO"
    case "assume_role":
      return "Assume Role"
    case "static":
      return "Static Credentials"
    case "environment":
      return "Environment Variables"
    default:
      return "Unknown"
  }
}
