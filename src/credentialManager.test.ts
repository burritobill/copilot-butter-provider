import { describe, expect, it } from "bun:test"

import { detectProfileType, parseAwsConfig } from "./credentialManager"

describe("parseAwsConfig", () => {
  it("parses profiles from AWS config format", () => {
    const config = `
[default]
region = us-east-1

[profile bedrock]
region = us-west-2
sso_start_url = https://my-sso.awsapps.com/start
sso_account_id = 123456789012
sso_role_name = MyRole
sso_region = us-east-1

[profile granted]
credential_process = granted credential-process --profile granted --auto-login
region = us-west-2
`
    const profiles = parseAwsConfig(config)
    expect(profiles).toHaveLength(3)

    expect(profiles[0]!.name).toBe("default")
    expect(profiles[0]!.fields.region).toBe("us-east-1")

    expect(profiles[1]!.name).toBe("bedrock")
    expect(profiles[1]!.type).toBe("sso")

    expect(profiles[2]!.name).toBe("granted")
    expect(profiles[2]!.type).toBe("credential_process")
  })

  it("parses assume-role profiles", () => {
    const config = `
[profile dev]
role_arn = arn:aws:iam::123456789012:role/DevRole
source_profile = default
region = us-west-2
`
    const profiles = parseAwsConfig(config)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.type).toBe("assume_role")
  })

  it("parses static credential profiles", () => {
    const config = `
[profile static-creds]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
`
    const profiles = parseAwsConfig(config)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.type).toBe("static")
  })

  it("handles empty config", () => {
    expect(parseAwsConfig("")).toEqual([])
  })

  it("skips comments and blank lines", () => {
    const config = `
# This is a comment
; Another comment

[default]
region = us-east-1
`
    const profiles = parseAwsConfig(config)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.name).toBe("default")
  })

  it("handles sso_session-based profiles", () => {
    const config = `
[profile sso-user]
sso_session = my-session
sso_account_id = 123456789012
sso_role_name = ViewOnly
region = us-west-2

[sso-session my-session]
sso_start_url = https://my-sso.awsapps.com/start
sso_region = us-east-1
`
    const profiles = parseAwsConfig(config)
    const ssoProfile = profiles.find((p) => p.name === "sso-user")
    expect(ssoProfile).toBeDefined()
    expect(ssoProfile!.type).toBe("sso")
  })
})

describe("detectProfileType", () => {
  it("detects credential_process", () => {
    expect(
      detectProfileType({ credential_process: "granted credential-process --profile x" }),
    ).toBe("credential_process")
  })

  it("detects SSO via sso_start_url", () => {
    expect(
      detectProfileType({
        sso_start_url: "https://example.awsapps.com/start",
        sso_account_id: "123",
        sso_role_name: "Role",
      }),
    ).toBe("sso")
  })

  it("detects SSO via sso_session", () => {
    expect(detectProfileType({ sso_session: "my-session", sso_account_id: "123" })).toBe("sso")
  })

  it("detects assume_role", () => {
    expect(
      detectProfileType({ role_arn: "arn:aws:iam::123:role/R", source_profile: "default" }),
    ).toBe("assume_role")
  })

  it("detects static credentials", () => {
    expect(
      detectProfileType({
        aws_access_key_id: "AKIA...",
        aws_secret_access_key: "secret",
      }),
    ).toBe("static")
  })

  it("returns unknown for empty fields", () => {
    expect(detectProfileType({ region: "us-west-2" })).toBe("unknown")
  })

  it("prioritizes credential_process over other fields", () => {
    expect(
      detectProfileType({
        credential_process: "some-process",
        sso_start_url: "https://example.awsapps.com/start",
      }),
    ).toBe("credential_process")
  })
})

describe("CredentialManager.checkForAuthError", () => {
  // We need the class to test instance methods
  let CredentialManager: typeof import("./credentialManager").CredentialManager

  // Dynamic import to use the mocked vscode
  it("setup", async () => {
    const mod = await import("./credentialManager")
    CredentialManager = mod.CredentialManager
  })

  function makeManager() {
    const outputChannel = { appendLine() {}, append() {}, show() {}, dispose() {} }
    return new CredentialManager(outputChannel as never)
  }

  it("detects ExpiredToken errors", () => {
    const mgr = makeManager()
    expect(mgr.checkForAuthError("ExpiredToken: The security token has expired")).toBe(true)
    expect(mgr.getCredentialState()).toBe("expired")
  })

  it("detects InvalidSignatureException", () => {
    const mgr = makeManager()
    expect(mgr.checkForAuthError("InvalidSignatureException: Signature mismatch")).toBe(true)
  })

  it("detects AccessDeniedException", () => {
    const mgr = makeManager()
    expect(mgr.checkForAuthError("AccessDeniedException: User is not authorized")).toBe(true)
  })

  it("detects 403 forbidden errors", () => {
    const mgr = makeManager()
    expect(mgr.checkForAuthError("HTTP 403 Forbidden - unauthorized access")).toBe(true)
  })

  it("detects expired security token message", () => {
    const mgr = makeManager()
    expect(mgr.checkForAuthError("The security token included in the request is expired")).toBe(
      true,
    )
  })

  it("does not false-positive on normal log output", () => {
    const mgr = makeManager()
    expect(mgr.checkForAuthError("Request completed successfully in 200ms")).toBe(false)
    expect(mgr.checkForAuthError("Starting server on port 8091")).toBe(false)
    expect(mgr.checkForAuthError("Model claude-sonnet-4 loaded")).toBe(false)
    expect(mgr.getCredentialState()).toBe("unchecked")
  })
})
