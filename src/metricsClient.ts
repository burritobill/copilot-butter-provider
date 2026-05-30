/**
 * Fetches and parses Butter's Prometheus metrics from `GET /metrics`.
 *
 * Butter's metrics plugin (OTel SDK → Prometheus exporter) exposes:
 *   - butter_request_total           (counter)
 *   - butter_request_duration_seconds (histogram: _bucket/_sum/_count)
 *   - butter_request_errors_total    (counter)
 * all labelled by provider, model, http_status_code, streaming, [app_key].
 *
 * These aggregates are process-wide (shared across all VS Code windows that use
 * the same Butter instance), which is exactly what a proxy-health dashboard wants.
 */

/** A single parsed Prometheus sample: metric name, labels, and value. */
interface Sample {
  name: string
  labels: Record<string, string>
  value: number
}

/** Per-model rollup of request counts, errors, and latency percentiles. */
interface ModelMetrics {
  model: string
  requests: number
  errors: number
  /** Mean latency in milliseconds (sum / count), or null when no samples. */
  avgLatencyMs: number | null
  /** Approximate p50/p95 latency in ms, interpolated from histogram buckets. */
  p50LatencyMs: number | null
  p95LatencyMs: number | null
}

/** A parsed snapshot of Butter's current metrics. */
export interface MetricsSnapshot {
  totalRequests: number
  totalErrors: number
  /** Overall error rate in [0, 1], or 0 when there are no requests. */
  errorRate: number
  models: ModelMetrics[]
  /** When this snapshot was taken. */
  fetchedAt: number
}

const METRICS_TIMEOUT_MS = 3_000

/**
 * Fetch and parse the metrics snapshot from a Butter base URL.
 * Returns null if metrics are unavailable (endpoint down or plugin disabled).
 */
export async function fetchMetrics(baseUrl: string): Promise<MetricsSnapshot | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), METRICS_TIMEOUT_MS)
    const res = await fetch(`${baseUrl}/metrics`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    const text = await res.text()
    return parseMetrics(text)
  } catch {
    return null
  }
}

/**
 * Parse Prometheus text-exposition format into a typed snapshot.
 * Exported for testing.
 */
export function parseMetrics(text: string): MetricsSnapshot {
  const samples = parseSamples(text)

  // Group histogram buckets/sum/count per model so we can derive percentiles.
  const totals = new Map<string, number>() // model -> request count
  const errors = new Map<string, number>() // model -> error count
  const durSum = new Map<string, number>() // model -> duration sum (seconds)
  const durCount = new Map<string, number>() // model -> duration count
  const buckets = new Map<string, Map<number, number>>() // model -> (le -> cumulative count)

  for (const s of samples) {
    const model = s.labels.model ?? "(unknown)"
    switch (s.name) {
      case "butter_request_total":
        totals.set(model, (totals.get(model) ?? 0) + s.value)
        break
      case "butter_request_errors_total":
        errors.set(model, (errors.get(model) ?? 0) + s.value)
        break
      case "butter_request_duration_seconds_sum":
        durSum.set(model, (durSum.get(model) ?? 0) + s.value)
        break
      case "butter_request_duration_seconds_count":
        durCount.set(model, (durCount.get(model) ?? 0) + s.value)
        break
      case "butter_request_duration_seconds_bucket": {
        const le = parseLe(s.labels.le)
        if (le === null) break
        let m = buckets.get(model)
        if (!m) {
          m = new Map()
          buckets.set(model, m)
        }
        m.set(le, (m.get(le) ?? 0) + s.value)
        break
      }
      default:
        break
    }
  }

  const modelNames = new Set<string>([...totals.keys(), ...errors.keys(), ...durCount.keys()])

  const models: ModelMetrics[] = []
  let totalRequests = 0
  let totalErrors = 0

  for (const model of modelNames) {
    const requests = totals.get(model) ?? 0
    const err = errors.get(model) ?? 0
    const sum = durSum.get(model) ?? 0
    const count = durCount.get(model) ?? 0
    const bk = buckets.get(model)

    totalRequests += requests
    totalErrors += err

    models.push({
      model,
      requests,
      errors: err,
      avgLatencyMs: count > 0 ? (sum / count) * 1000 : null,
      p50LatencyMs: bk ? quantileFromBuckets(bk, count, 0.5) : null,
      p95LatencyMs: bk ? quantileFromBuckets(bk, count, 0.95) : null,
    })
  }

  models.sort((a, b) => b.requests - a.requests)

  return {
    totalRequests,
    totalErrors,
    errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
    models,
    fetchedAt: Date.now(),
  }
}

/** Parse `le="0.5"` (or `le="+Inf"`) into a number, or null if malformed. */
function parseLe(le: string | undefined): number | null {
  if (le === undefined) return null
  if (le === "+Inf") return Number.POSITIVE_INFINITY
  const n = Number(le)
  return Number.isNaN(n) ? null : n
}

/**
 * Approximate a quantile (ms) from cumulative histogram buckets using linear
 * interpolation within the matching bucket — the same approach as PromQL's
 * histogram_quantile.
 */
function quantileFromBuckets(
  bucketMap: Map<number, number>,
  count: number,
  q: number,
): number | null {
  if (count <= 0) return null
  // Sort buckets by upper bound (le).
  const sorted = [...bucketMap.entries()].sort((a, b) => a[0] - b[0])
  if (sorted.length === 0) return null

  const rank = q * count
  let prevLe = 0
  let prevCount = 0
  for (const [le, cumCount] of sorted) {
    if (cumCount >= rank) {
      if (le === Number.POSITIVE_INFINITY) {
        // Quantile falls in the overflow bucket — best estimate is the last
        // finite bound.
        return prevLe > 0 ? prevLe * 1000 : null
      }
      // Linear interpolation between the previous bound and this one.
      const bucketCount = cumCount - prevCount
      const within = bucketCount > 0 ? (rank - prevCount) / bucketCount : 0
      const seconds = prevLe + (le - prevLe) * within
      return seconds * 1000
    }
    prevLe = le
    prevCount = cumCount
  }
  return null
}

/**
 * Parse Prometheus text exposition format into individual samples, skipping
 * `# HELP`/`# TYPE` comments and the exporter's `otel_scope_*`/`target_info`
 * info metrics.
 */
function parseSamples(text: string): Sample[] {
  const out: Sample[] = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue

    const { name, labels, rest } = splitNameAndLabels(line)
    if (name === null) continue
    if (!name.startsWith("butter_")) continue

    // Value is the first whitespace-separated token of the remainder
    // (an optional trailing timestamp is ignored).
    const value = Number(rest.trim().split(/\s+/)[0])
    if (Number.isNaN(value)) continue

    out.push({ name, labels, value })
  }
  return out
}

/**
 * Split a sample line into metric name, label map, and the trailing value text.
 * Handles `name{a="1",b="2"} 3` and `name 3`.
 */
function splitNameAndLabels(line: string): {
  name: string | null
  labels: Record<string, string>
  rest: string
} {
  const braceIdx = line.indexOf("{")
  if (braceIdx === -1) {
    const spaceIdx = line.indexOf(" ")
    if (spaceIdx === -1) return { name: null, labels: {}, rest: "" }
    return { name: line.slice(0, spaceIdx), labels: {}, rest: line.slice(spaceIdx + 1) }
  }

  const name = line.slice(0, braceIdx)
  const closeIdx = line.indexOf("}", braceIdx)
  if (closeIdx === -1) return { name: null, labels: {}, rest: "" }

  const labelStr = line.slice(braceIdx + 1, closeIdx)
  const rest = line.slice(closeIdx + 1)
  return { name, labels: parseLabels(labelStr), rest }
}

/** Parse `a="1",b="2"` into { a: "1", b: "2" }. */
function parseLabels(labelStr: string): Record<string, string> {
  const labels: Record<string, string> = {}
  // Match key="value" pairs; values may contain escaped quotes.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(labelStr)) !== null) {
    const key = match[1]!
    const value = match[2]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n")
    labels[key] = value
  }
  return labels
}
