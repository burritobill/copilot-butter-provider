import { describe, expect, it } from "bun:test"

import { serializeYaml } from "./configManager"

describe("serializeYaml", () => {
  it("serializes flat key-value pairs", () => {
    const result = serializeYaml({ name: "test", port: 8091, enabled: true })
    expect(result).toBe("name: test\nport: 8091\nenabled: true\n")
  })

  it("serializes nested objects with indentation", () => {
    const result = serializeYaml({
      server: { address: "127.0.0.1:8091", read_timeout: "30s" },
    })
    expect(result).toBe('server:\n  address: "127.0.0.1:8091"\n  read_timeout: 30s\n')
  })

  it("serializes arrays of primitives", () => {
    const result = serializeYaml({ retry_on: [429, 500, 502] })
    expect(result).toBe("retry_on:\n  - 429\n  - 500\n  - 502\n")
  })

  it("quotes strings with special characters", () => {
    const result = serializeYaml({ address: "127.0.0.1:8091" })
    expect(result).toBe('address: "127.0.0.1:8091"\n')
  })

  it("does not quote plain strings", () => {
    const result = serializeYaml({ level: "info" })
    expect(result).toBe("level: info\n")
  })

  it("skips null and undefined values", () => {
    const result = serializeYaml({ a: "yes", b: null, c: undefined, d: "ok" })
    expect(result).toBe("a: yes\nd: ok\n")
  })

  it("produces a valid Butter-style config", () => {
    const config = {
      server: { address: "127.0.0.1:8091", read_timeout: "30s", write_timeout: "120s" },
      providers: {
        bedrock: { region: "us-west-2", aws_profile: "my-profile" },
      },
      routing: {
        default_provider: "bedrock",
        failover: {
          enabled: true,
          max_retries: 3,
          retry_on: [429, 500],
          backoff: { initial: "100ms", multiplier: 2.0, max: "5s" },
        },
      },
      plugins: {
        requestlog: { level: "info" },
      },
    }

    const yaml = serializeYaml(config)

    // Verify key structure elements are present
    expect(yaml).toContain('address: "127.0.0.1:8091"')
    expect(yaml).toContain("region: us-west-2")
    expect(yaml).toContain("aws_profile: my-profile")
    expect(yaml).toContain("default_provider: bedrock")
    expect(yaml).toContain("enabled: true")
    expect(yaml).toContain("  - 429")
    expect(yaml).toContain("level: info")
  })
})
