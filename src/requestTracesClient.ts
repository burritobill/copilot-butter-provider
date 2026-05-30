import type { RequestLogEntry } from "./requestLogStore"

interface RequestTraceItem {
  timestamp?: string
  provider?: string
  model?: string
  status_code?: number
  duration_ms?: number
  error?: string
  method?: string
  path?: string
  streaming?: boolean
  app_key?: string
  request_id?: string
  request_body?: string
  response_body?: string
}

interface RequestTraceResponse {
  requests?: RequestTraceItem[]
}

/**
 * Fetch process-wide recent request traces from Butter's GET /v1/requests.
 * Returns null when the endpoint is unavailable (e.g. older Butter build).
 */
export async function fetchRequestTraces(
  baseUrl: string,
  limit: number,
): Promise<RequestLogEntry[] | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/v1/requests?limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) return null

    const json = (await res.json()) as RequestTraceResponse
    const items = Array.isArray(json.requests) ? json.requests : []
    return items.map((it) => ({
      time: typeof it.timestamp === "string" ? it.timestamp : new Date().toISOString(),
      provider: typeof it.provider === "string" ? it.provider : "(unknown)",
      model: typeof it.model === "string" ? it.model : "(unknown)",
      status: typeof it.status_code === "number" ? it.status_code : 0,
      durationMs: typeof it.duration_ms === "number" ? it.duration_ms : 0,
      requestId: it.request_id,
      method: it.method,
      path: it.path,
      streaming: typeof it.streaming === "boolean" ? it.streaming : undefined,
      appKey: it.app_key,
      requestBody: it.request_body,
      responseBody: it.response_body,
      error: it.error,
    }))
  } catch {
    return null
  }
}
