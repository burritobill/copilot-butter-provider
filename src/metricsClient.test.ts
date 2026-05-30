import { describe, expect, it } from "bun:test"

import { parseMetrics } from "./metricsClient"

// A representative slice of Butter's Prometheus output (OTel exporter format).
const SAMPLE = `
# HELP butter_request_total Total number of requests processed
# TYPE butter_request_total counter
butter_request_total{provider="bedrock",model="claude-sonnet-4",http_status_code="200",streaming="true"} 8
butter_request_total{provider="bedrock",model="claude-haiku",http_status_code="200",streaming="false"} 2
butter_request_total{provider="bedrock",model="claude-haiku",http_status_code="429",streaming="false"} 3
# HELP butter_request_errors_total Total number of failed requests
# TYPE butter_request_errors_total counter
butter_request_errors_total{provider="bedrock",model="claude-haiku",http_status_code="429",streaming="false"} 3
# HELP butter_request_duration_seconds Request duration in seconds
# TYPE butter_request_duration_seconds histogram
butter_request_duration_seconds_bucket{model="claude-sonnet-4",le="0.5"} 2
butter_request_duration_seconds_bucket{model="claude-sonnet-4",le="1"} 6
butter_request_duration_seconds_bucket{model="claude-sonnet-4",le="2"} 8
butter_request_duration_seconds_bucket{model="claude-sonnet-4",le="+Inf"} 8
butter_request_duration_seconds_sum{model="claude-sonnet-4"} 8
butter_request_duration_seconds_count{model="claude-sonnet-4"} 8
# Some unrelated exporter info metric that must be ignored
otel_scope_info{otel_scope_name="github.com/temikus/butter"} 1
target_info{service_name="butter"} 1
`

describe("parseMetrics", () => {
  it("aggregates totals and error rate across models", () => {
    const snap = parseMetrics(SAMPLE)
    // 8 + 2 + 3 = 13 requests
    expect(snap.totalRequests).toBe(13)
    expect(snap.totalErrors).toBe(3)
    expect(snap.errorRate).toBeCloseTo(3 / 13, 5)
  })

  it("rolls up per-model counts and errors", () => {
    const snap = parseMetrics(SAMPLE)
    const sonnet = snap.models.find((m) => m.model === "claude-sonnet-4")
    const haiku = snap.models.find((m) => m.model === "claude-haiku")

    expect(sonnet?.requests).toBe(8)
    expect(sonnet?.errors).toBe(0)
    // haiku: 2 (200) + 3 (429) = 5 requests, 3 errors
    expect(haiku?.requests).toBe(5)
    expect(haiku?.errors).toBe(3)
  })

  it("computes average latency from sum/count", () => {
    const snap = parseMetrics(SAMPLE)
    const sonnet = snap.models.find((m) => m.model === "claude-sonnet-4")
    // 8s / 8 = 1s = 1000ms
    expect(sonnet?.avgLatencyMs).toBeCloseTo(1000, 1)
  })

  it("interpolates p50/p95 from histogram buckets", () => {
    const snap = parseMetrics(SAMPLE)
    const sonnet = snap.models.find((m) => m.model === "claude-sonnet-4")
    // p50 rank = 4 → within the le=1 bucket (cum 2→6); interpolated between 0.5s and 1s.
    expect(sonnet?.p50LatencyMs).not.toBeNull()
    expect(sonnet!.p50LatencyMs!).toBeGreaterThan(500)
    expect(sonnet!.p50LatencyMs!).toBeLessThanOrEqual(1000)
    // p95 rank = 7.6 → within the le=2 bucket (cum 6→8).
    expect(sonnet!.p95LatencyMs!).toBeGreaterThan(1000)
    expect(sonnet!.p95LatencyMs!).toBeLessThanOrEqual(2000)
  })

  it("sorts models by request count descending", () => {
    const snap = parseMetrics(SAMPLE)
    expect(snap.models[0]!.model).toBe("claude-sonnet-4")
  })

  it("ignores non-butter and comment lines", () => {
    const snap = parseMetrics(SAMPLE)
    expect(snap.models.every((m) => m.model !== "")).toBe(true)
    expect(snap.models.find((m) => m.model.includes("otel"))).toBeUndefined()
  })

  it("returns zeroed snapshot for empty input", () => {
    const snap = parseMetrics("")
    expect(snap.totalRequests).toBe(0)
    expect(snap.errorRate).toBe(0)
    expect(snap.models).toHaveLength(0)
  })
})
