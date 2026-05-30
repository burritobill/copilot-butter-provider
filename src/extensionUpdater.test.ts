import { describe, expect, it } from "bun:test"

import { type GitHubRelease, resolveUpdate } from "./extensionUpdater"

describe("resolveUpdate", () => {
  const makeRelease = (tag: string, assets: string[] = []): GitHubRelease => ({
    tag_name: tag,
    assets: assets.map((name) => ({
      name,
      browser_download_url: `https://github.com/download/${name}`,
    })),
  })

  it("returns undefined when versions match (no v prefix)", () => {
    const release = makeRelease("v0.0.3", ["butter-copilot-0.0.3.vsix"])
    expect(resolveUpdate("0.0.3", release)).toBeUndefined()
  })

  it("returns undefined when versions match (tag without v prefix)", () => {
    const release = makeRelease("0.0.3", ["butter-copilot-0.0.3.vsix"])
    expect(resolveUpdate("0.0.3", release)).toBeUndefined()
  })

  it("returns update info when a newer version is available", () => {
    const release = makeRelease("v0.0.4", ["butter-copilot-0.0.4.vsix"])
    const result = resolveUpdate("0.0.3", release)
    expect(result).toEqual({
      latest: "0.0.4",
      vsixAsset: {
        name: "butter-copilot-0.0.4.vsix",
        browser_download_url: "https://github.com/download/butter-copilot-0.0.4.vsix",
      },
    })
  })

  it("returns undefined when no .vsix asset exists", () => {
    const release = makeRelease("v0.0.4", ["butter-copilot.tar.gz", "butter-copilot-0.0.4.tar.gz"])
    expect(resolveUpdate("0.0.3", release)).toBeUndefined()
  })

  it("returns undefined when assets array is empty", () => {
    const release = makeRelease("v0.0.4", [])
    expect(resolveUpdate("0.0.3", release)).toBeUndefined()
  })

  it("picks the .vsix from among multiple assets", () => {
    const release = makeRelease("v1.0.0", [
      "butter-copilot.tar.gz",
      "butter-copilot-1.0.0.vsix",
      "checksums.txt",
    ])
    const result = resolveUpdate("0.0.3", release)
    expect(result?.latest).toBe("1.0.0")
    expect(result?.vsixAsset.name).toBe("butter-copilot-1.0.0.vsix")
  })
})
