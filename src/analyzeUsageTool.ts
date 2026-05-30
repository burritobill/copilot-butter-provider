/**
 * Language Model tool `butter_analyzeUsage`.
 *
 * Copilot can invoke this to get a structured summary of recent Butter proxy
 * activity (model usage, error clusters, latency outliers) so it can propose
 * model-selection / prompting guidance for the workspace's agent-instructions
 * file (AGENTS.md, CLAUDE.md, or .github/copilot-instructions.md).
 *
 * The tool returns a SUMMARY only — it never dumps raw request/response bodies
 * into the model, even when body logging is enabled.
 */

import * as vscode from "vscode"

import { fetchMetrics, type MetricsSnapshot } from "./metricsClient"
import type { RequestLogEntry, RequestLogStore } from "./requestLogStore"
import { fetchRequestTraces } from "./requestTracesClient"
import { computeUsageSignals } from "./usageSignals"

interface AnalyzeUsageInput {
  /** Optional cap on how many recent requests to consider. */
  limit?: number
}

/** Candidate agent-instruction filenames, in priority order. */
const AGENT_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"]

export class AnalyzeUsageTool implements vscode.LanguageModelTool<AnalyzeUsageInput> {
  constructor(
    private readonly getBaseUrl: () => string,
    private readonly logStore: RequestLogStore,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AnalyzeUsageInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const limit = options.input.limit ?? 200
    const endpointEntries = await fetchRequestTraces(this.getBaseUrl(), limit)
    const entries = endpointEntries ?? this.logStore.getEntries(limit)
    const metrics = await fetchMetrics(this.getBaseUrl())
    const agentFile = await detectAgentFile()

    const report = buildReport(metrics, entries, agentFile)
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(report)])
  }

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Analyzing Butter usage" }
  }
}

function buildReport(
  metrics: MetricsSnapshot | null,
  entries: RequestLogEntry[],
  agentFile: string | null,
): string {
  const lines: string[] = []
  lines.push("# Butter usage analysis")
  lines.push("")
  lines.push(
    "This summary reflects observed AI-proxy traffic (model usage, errors, latency). " +
      "Use it to suggest model-selection and prompting guidance. It does NOT describe " +
      "the codebase itself — only proxy behaviour.",
  )
  lines.push("")

  // --- Aggregate metrics (process-wide, from /metrics) ---
  if (metrics) {
    lines.push("## Aggregate metrics (all windows)")
    lines.push(`- Total requests: ${metrics.totalRequests}`)
    lines.push(`- Total errors: ${metrics.totalErrors}`)
    lines.push(`- Error rate: ${(metrics.errorRate * 100).toFixed(1)}%`)
    lines.push("")
    if (metrics.models.length > 0) {
      lines.push("### Per-model")
      lines.push("| Model | Requests | Errors | Error % | Avg ms | p95 ms |")
      lines.push("|---|---|---|---|---|---|")
      for (const m of metrics.models) {
        const errPct = m.requests > 0 ? ((m.errors / m.requests) * 100).toFixed(1) : "0.0"
        lines.push(
          `| ${m.model} | ${m.requests} | ${m.errors} | ${errPct}% | ` +
            `${fmtMs(m.avgLatencyMs)} | ${fmtMs(m.p95LatencyMs)} |`,
        )
      }
      lines.push("")
    }
  } else {
    lines.push("## Aggregate metrics")
    lines.push("_Metrics endpoint unavailable (Butter not running or metrics plugin disabled)._")
    lines.push("")
  }

  // --- Per-request detail (this window only) ---
  if (entries.length > 0) {
    const errors = entries.filter((e) => e.status >= 400 || e.error)
    const signals = computeUsageSignals(entries)
    lines.push("## Recent request detail (this window)")
    lines.push(`- Requests captured: ${entries.length}`)
    lines.push(`- Failed: ${errors.length}`)
    lines.push("")

    lines.push("### Workspace diagnostics")
    lines.push(`- Context pressure errors: ${signals.contextPressureFailures}`)
    lines.push(
      `- Tool-related failures: ${signals.toolRelatedFailures} / ${signals.toolRelatedRequests}`,
    )
    lines.push(`- Top failing model: ${signals.topFailingModel ?? "none"}`)
    lines.push(`- Top failing endpoint: ${signals.topFailingEndpoint ?? "none"}`)
    lines.push("")

    const errorClusters = clusterErrors(errors)
    if (errorClusters.length > 0) {
      lines.push("### Error clusters")
      lines.push("| Model | Status | Count | Example |")
      lines.push("|---|---|---|---|")
      for (const c of errorClusters) {
        lines.push(`| ${c.model} | ${c.status} | ${c.count} | ${truncate(c.example, 120)} |`)
      }
      lines.push("")
    }

    const slow = slowestByModel(entries)
    if (slow.length > 0) {
      lines.push("### Latency outliers (slowest observed per model)")
      lines.push("| Model | Max ms |")
      lines.push("|---|---|")
      for (const s of slow) lines.push(`| ${s.model} | ${s.maxMs} |`)
      lines.push("")
    }
  } else {
    lines.push("## Recent request detail")
    lines.push(
      "_No per-request logs captured in this window. Only the window that started Butter " +
        "sees its request log; rely on the aggregate metrics above._",
    )
    lines.push("")
  }

  // --- Guidance for the model ---
  lines.push("## Suggested next step")
  if (agentFile) {
    lines.push(
      `An agent-instructions file exists at \`${agentFile}\`. Based on the patterns above, ` +
        "propose concise edits (e.g. preferred models for specific task types, notes about " +
        "models with high error/latency, context-size cautions). Keep suggestions grounded in " +
        "the observed data; do not invent codebase conventions.",
    )
  } else {
    lines.push(
      "No agent-instructions file found (looked for AGENTS.md, CLAUDE.md, " +
        ".github/copilot-instructions.md). If the user wants, propose creating one with " +
        "model-selection guidance derived from the data above.",
    )
  }

  return lines.join("\n")
}

interface ErrorCluster {
  model: string
  status: number
  count: number
  example: string
}

function clusterErrors(errors: RequestLogEntry[]): ErrorCluster[] {
  const map = new Map<string, ErrorCluster>()
  for (const e of errors) {
    const key = `${e.model}|${e.status}`
    const existing = map.get(key)
    if (existing) {
      existing.count++
      if (!existing.example && e.error) existing.example = e.error
    } else {
      map.set(key, { model: e.model, status: e.status, count: 1, example: e.error ?? "" })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

function slowestByModel(entries: RequestLogEntry[]): Array<{ model: string; maxMs: number }> {
  const map = new Map<string, number>()
  for (const e of entries) {
    map.set(e.model, Math.max(map.get(e.model) ?? 0, e.durationMs))
  }
  return [...map.entries()]
    .map(([model, maxMs]) => ({ model, maxMs }))
    .sort((a, b) => b.maxMs - a.maxMs)
    .slice(0, 10)
}

async function detectAgentFile(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) return null
  const root = folders[0]!.uri
  for (const candidate of AGENT_FILES) {
    const uri = vscode.Uri.joinPath(root, candidate)
    try {
      await vscode.workspace.fs.stat(uri)
      return candidate
    } catch {
      // not found; try next
    }
  }
  return null
}

function fmtMs(v: number | null): string {
  return v === null ? "—" : String(Math.round(v))
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
