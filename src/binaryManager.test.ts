import { describe, expect, it } from "bun:test"

import { getAssetName, parseChecksumForAsset } from "./binaryManager"

describe("getAssetName", () => {
  it("returns a tar.gz filename with version, os, and arch", () => {
    const name = getAssetName("0.6.0")
    expect(name).toMatch(/^butter_0\.6\.0_(darwin|linux)_(amd64|arm64)\.tar\.gz$/)
  })
})

describe("parseChecksumForAsset", () => {
  const checksums = [
    "65ae2804db21112a26a6258609a4e7dfd919f6907555dcab2dd9251219cc107d  butter_0.6.0_linux_amd64.tar.gz",
    "3746f2bfb40790eb017e72adb7f6e1c371f2b22a23cca1768592050f71d15d16  butter_0.6.0_linux_arm64.tar.gz",
    "eee856062f65ef7ca356cc843bcb9e94d61104d2a630eabf84991fcb3a236ef9  butter_0.6.0_darwin_amd64.tar.gz",
    "bcc22a25d78f3125ede1308d40ec034bb765b876f7fb26962a32a264ede569ac  butter_0.6.0_darwin_arm64.tar.gz",
  ].join("\n")

  it("finds the correct checksum for a given asset", () => {
    expect(parseChecksumForAsset(checksums, "butter_0.6.0_linux_amd64.tar.gz")).toBe(
      "65ae2804db21112a26a6258609a4e7dfd919f6907555dcab2dd9251219cc107d",
    )
  })

  it("finds darwin arm64 checksum", () => {
    expect(parseChecksumForAsset(checksums, "butter_0.6.0_darwin_arm64.tar.gz")).toBe(
      "bcc22a25d78f3125ede1308d40ec034bb765b876f7fb26962a32a264ede569ac",
    )
  })

  it("returns undefined for unknown asset", () => {
    expect(parseChecksumForAsset(checksums, "butter_0.6.0_windows_amd64.tar.gz")).toBeUndefined()
  })

  it("returns undefined for empty checksums", () => {
    expect(parseChecksumForAsset("", "butter_0.6.0_linux_amd64.tar.gz")).toBeUndefined()
  })
})
