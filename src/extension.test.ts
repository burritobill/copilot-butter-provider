import { describe, expect, it } from "bun:test"

describe("extension", () => {
  it("exports activate and deactivate", async () => {
    const mod = await import("./extension")
    expect(typeof mod.activate).toBe("function")
    expect(typeof mod.deactivate).toBe("function")
  })
})
