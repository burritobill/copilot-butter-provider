/**
 * In-memory ring buffer of recent Butter request-trace log lines.
 *
 * Butter's `requestlog` plugin emits one structured JSON line per completed
 * request to stdout (msg="request trace"). The extension already pipes Butter's
 * stdout into its output channel; this store taps the same stream so the
 * dashboard and the `butter_analyzeUsage` tool have per-request detail.
 *
 * Limitation: with single-instance adoption across windows, only the window
 * that *spawned* Butter sees its stdout. Adopting windows will have an empty
 * store and must rely on /metrics (which is process-wide) instead.
 */

import * as vscode from "vscode"

/** A parsed request-trace entry. Optional fields depend on plugin config. */
export interface RequestLogEntry {
  /** slog timestamp (ISO 8601) if present, else ingestion time. */
  time: string
  provider: string
  model: string
  status: number
  durationMs: number
  requestId?: string
  method?: string
  path?: string
  streaming?: boolean
  appKey?: string
  /** Present only when `log_bodies` is enabled in Butter config. */
  requestBody?: string
  responseBody?: string
  error?: string
}

const DEFAULT_CAPACITY = 500

export class RequestLogStore {
  private readonly buffer: RequestLogEntry[] = []
  private partial = ""

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>()
  /** Fires when one or more entries are ingested. */
  readonly onDidChange = this.onDidChangeEmitter.event

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /**
   * Ingest a raw chunk of stdout text. Buffers partial lines across chunks,
   * parses each complete line as JSON, and keeps only "request trace" entries.
   */
  ingestChunk(chunk: string): void {
    this.partial += chunk
    const lines = this.partial.split("\n")
    // The last element is an incomplete line (no trailing newline yet).
    this.partial = lines.pop() ?? ""

    let added = false
    for (const line of lines) {
      if (this.ingestLine(line)) added = true
    }
    if (added) this.onDidChangeEmitter.fire()
  }

  /** Parse and store a single line. Returns true if an entry was added. */
  private ingestLine(line: string): boolean {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed[0] !== "{") return false

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return false
    }

    if (obj.msg !== "request trace") return false

    const entry: RequestLogEntry = {
      time: typeof obj.time === "string" ? obj.time : new Date().toISOString(),
      provider: str(obj.provider) ?? "(unknown)",
      model: str(obj.model) ?? "(unknown)",
      status: num(obj.status) ?? 0,
      durationMs: num(obj.duration_ms) ?? 0,
      requestId: str(obj.request_id),
      method: str(obj.method),
      path: str(obj.path),
      streaming: typeof obj.streaming === "boolean" ? obj.streaming : undefined,
      appKey: str(obj.app_key),
      requestBody: str(obj.request_body),
      responseBody: str(obj.response_body),
      error: str(obj.error),
    }

    this.buffer.push(entry)
    if (this.buffer.length > this.capacity) this.buffer.shift()
    return true
  }

  /** Most-recent-first list of entries, optionally limited. */
  getEntries(limit?: number): RequestLogEntry[] {
    const all = [...this.buffer].reverse()
    return limit !== undefined ? all.slice(0, limit) : all
  }

  get size(): number {
    return this.buffer.length
  }

  clear(): void {
    this.buffer.length = 0
    this.partial = ""
    this.onDidChangeEmitter.fire()
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose()
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}
