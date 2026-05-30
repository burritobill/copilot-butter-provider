import { type ChildProcess, spawn } from "node:child_process"

import * as vscode from "vscode"

import type { BinaryManager } from "./binaryManager"
import type { ConfigManager } from "./configManager"
import type { CredentialManager } from "./credentialManager"

export type ProcessState = "stopped" | "starting" | "running" | "error"

/** Resolved runtime settings the manager needs. Injectable for testing. */
export interface ProcessSettings {
  mode: string
  port: number
  externalUrl: string
}

function readSettings(): ProcessSettings {
  const settings = vscode.workspace.getConfiguration("butter-copilot")
  return {
    mode: settings.get<string>("mode", "managed"),
    port: settings.get<number>("port", 8091),
    externalUrl: settings.get<string>("externalUrl", "http://localhost:8080"),
  }
}

const HEALTH_INTERVAL_MS = 10_000
const HEALTH_TIMEOUT_MS = 3_000
const MAX_HEALTH_FAILURES = 3
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]

export class ProcessManager {
  private process: ChildProcess | null = null
  private state: ProcessState = "stopped"
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private consecutiveHealthFailures = 0
  private restartCount = 0
  private disposed = false
  // True when we attached to a Butter instance started by another VS Code
  // window (shared, on the same port) instead of spawning our own. We must
  // never kill or restart a process we don't own.
  private adopted = false

  private readonly onStateChangeEmitter = new vscode.EventEmitter<ProcessState>()
  readonly onStateChange = this.onStateChangeEmitter.event

  // Fires for each raw chunk of Butter's stdout (where structured JSON request
  // logs are written). Consumers like RequestLogStore parse these.
  private readonly onLogChunkEmitter = new vscode.EventEmitter<string>()
  readonly onLogChunk = this.onLogChunkEmitter.event

  private authErrorDebounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly binaryManager: BinaryManager,
    private readonly configManager: ConfigManager,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly credentialManager?: CredentialManager,
    private readonly getSettings: () => ProcessSettings = readSettings,
  ) {}

  getState(): ProcessState {
    return this.state
  }

  getBaseUrl(): string {
    const { mode, port, externalUrl } = this.getSettings()
    if (mode === "external") return externalUrl
    return `http://127.0.0.1:${port}`
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") return

    const mode = this.getSettings().mode
    if (mode === "external") {
      this.setState("running")
      this.startHealthChecks()
      return
    }

    this.setState("starting")

    // Another VS Code window may already be running a managed Butter on this
    // port. Butter is a stateless, shared proxy, so adopt the existing instance
    // rather than spawning a duplicate (which would fail with "port in use").
    if (await this.checkHealth()) {
      this.adopted = true
      this.outputChannel.appendLine(
        `Adopting existing Butter at ${this.getBaseUrl()} (started by another window)`,
      )
      this.setState("running")
      this.restartCount = 0
      this.startHealthChecks()
      return
    }

    // We're spawning our own process, so we're no longer adopting another's.
    this.adopted = false

    const binaryPath = this.binaryManager.getBinaryPath()
    const configPath = await this.configManager.ensureConfig()

    this.outputChannel.appendLine(`Starting Butter: ${binaryPath} -config ${configPath}`)

    this.process = spawn(binaryPath, ["-config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })

    this.process.stdout?.on("data", (data: Buffer) => {
      const text = data.toString()
      this.outputChannel.append(text)
      this.onLogChunkEmitter.fire(text)
    })

    this.process.stderr?.on("data", (data: Buffer) => {
      const text = data.toString()
      this.outputChannel.append(text)
      if (this.credentialManager?.checkForAuthError(text)) {
        this.handleAuthError()
      }
    })

    this.process.on("error", (err) => {
      this.outputChannel.appendLine(`Butter process error: ${err.message}`)
      this.setState("error")
      this.scheduleRestart()
    })

    this.process.on("exit", (code, signal) => {
      this.outputChannel.appendLine(
        `Butter exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      )
      this.process = null

      if (!this.disposed && this.state !== "stopped") {
        this.setState("error")
        this.scheduleRestart()
      }
    })

    // Wait briefly for the process to start, then begin health checks
    await this.waitForHealthy(5_000)
  }

  async stop(): Promise<void> {
    this.stopHealthChecks()
    this.restartCount = 0

    // Adopted instances are owned by another window — detach without killing.
    if (this.adopted) {
      this.adopted = false
      this.outputChannel.appendLine("Detaching from adopted Butter (not stopping it)")
      this.setState("stopped")
      return
    }

    if (!this.process) {
      this.setState("stopped")
      return
    }

    this.outputChannel.appendLine("Stopping Butter...")
    this.setState("stopped")

    const proc = this.process
    this.process = null

    // Graceful shutdown: SIGTERM, then SIGKILL after timeout
    proc.kill("SIGTERM")

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL")
        resolve()
      }, 5_000)

      proc.on("exit", () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.outputChannel.appendLine("Butter stopped")
  }

  async restart(): Promise<void> {
    await this.stop()
    this.restartCount = 0
    await this.start()
  }

  dispose(): void {
    this.disposed = true
    this.stopHealthChecks()
    // Only kill a process we own. Adopted instances belong to another window
    // and should keep running for it.
    if (this.process && !this.adopted) {
      this.process.kill("SIGTERM")
    }
    this.process = null
    this.onLogChunkEmitter.dispose()
    this.onStateChangeEmitter.dispose()
  }

  private setState(state: ProcessState): void {
    if (this.state !== state) {
      this.state = state
      this.onStateChangeEmitter.fire(state)
    }
  }

  private async waitForHealthy(timeoutMs: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await this.checkHealth()) {
        this.setState("running")
        this.restartCount = 0
        this.startHealthChecks()
        return
      }
      await sleep(500)
    }

    // Still mark as running — healthchecks will catch real failures
    if (this.process && !this.process.killed) {
      this.setState("running")
      this.startHealthChecks()
    }
  }

  private startHealthChecks(): void {
    this.stopHealthChecks()
    this.consecutiveHealthFailures = 0

    this.healthTimer = setInterval(async () => {
      const healthy = await this.checkHealth()

      if (healthy) {
        this.consecutiveHealthFailures = 0
        if (this.state !== "running") this.setState("running")
      } else {
        this.consecutiveHealthFailures++
        this.outputChannel.appendLine(
          `Health check failed (${this.consecutiveHealthFailures}/${MAX_HEALTH_FAILURES})`,
        )

        if (this.consecutiveHealthFailures >= MAX_HEALTH_FAILURES) {
          this.outputChannel.appendLine("Max health failures reached, restarting...")
          this.stopHealthChecks()
          this.setState("error")
          await this.restart()
        }
      }
    }, HEALTH_INTERVAL_MS)
  }

  private stopHealthChecks(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)

      const response = await fetch(`${this.getBaseUrl()}/healthz`, {
        signal: controller.signal,
      })

      clearTimeout(timeout)
      return response.ok
    } catch {
      return false
    }
  }

  private scheduleRestart(): void {
    if (this.disposed) return

    const delay = RESTART_BACKOFF_MS[Math.min(this.restartCount, RESTART_BACKOFF_MS.length - 1)]!
    this.restartCount++

    this.outputChannel.appendLine(`Scheduling restart in ${delay}ms (attempt ${this.restartCount})`)

    setTimeout(async () => {
      if (this.disposed || this.state === "running" || this.state === "starting") return
      try {
        await this.start()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.outputChannel.appendLine(`Restart failed: ${msg}`)
      }
    }, delay)
  }

  /**
   * Debounced handler for auth errors detected in stderr.
   * Prevents spamming the user with multiple notifications from rapid error lines.
   */
  private handleAuthError(): void {
    if (this.authErrorDebounceTimer) return

    this.authErrorDebounceTimer = setTimeout(() => {
      this.authErrorDebounceTimer = null
    }, 30_000)

    this.outputChannel.appendLine("AWS authentication error detected in Butter output")
    void this.credentialManager?.handleAuthFailure()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
