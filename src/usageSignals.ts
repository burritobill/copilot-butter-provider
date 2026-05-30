import type { RequestLogEntry } from "./requestLogStore"

export interface UsageSignals {
  total: number
  failures: number
  contextPressureFailures: number
  toolRelatedRequests: number
  toolRelatedFailures: number
  topFailingModel: string | null
  topFailingEndpoint: string | null
}

const CONTEXT_ERROR_RE =
  /context|token limit|too many tokens|max(?:imum)? context|prompt too long|context_length_exceeded|input is too long/i

const TOOL_RELATED_RE = /tool_call|tool calls|function call|"tools"|"tool_calls"/i

export function computeUsageSignals(entries: RequestLogEntry[]): UsageSignals {
  const failed = entries.filter((e) => e.status >= 400 || Boolean(e.error))

  const contextPressureFailures = failed.filter((e) => CONTEXT_ERROR_RE.test(e.error ?? "")).length

  const toolRelated = entries.filter(isToolRelated)
  const toolRelatedFailures = toolRelated.filter((e) => e.status >= 400 || Boolean(e.error)).length

  const topFailingModel = topFailing(failed, (e) => e.model)
  const topFailingEndpoint = topFailing(failed, (e) => e.path ?? "(unknown)")

  return {
    total: entries.length,
    failures: failed.length,
    contextPressureFailures,
    toolRelatedRequests: toolRelated.length,
    toolRelatedFailures,
    topFailingModel,
    topFailingEndpoint,
  }
}

function isToolRelated(entry: RequestLogEntry): boolean {
  if (entry.path === "/v1/chat/completions" || entry.path === "/v1/responses") {
    if (TOOL_RELATED_RE.test(entry.error ?? "")) return true
    if (TOOL_RELATED_RE.test(entry.requestBody ?? "")) return true
    if (TOOL_RELATED_RE.test(entry.responseBody ?? "")) return true
  }
  return false
}

function topFailing(
  entries: RequestLogEntry[],
  keyFn: (e: RequestLogEntry) => string,
): string | null {
  if (entries.length === 0) return null
  const counts = new Map<string, number>()
  for (const e of entries) {
    const key = keyFn(e)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let bestKey: string | null = null
  let bestCount = -1
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count
      bestKey = key
    }
  }
  return bestKey
}
