import { describe, expect, it, mock } from "bun:test"

void mock.module("vscode", () => ({
  EventEmitter: class {
    fire() {}
    dispose() {}
    event() {}
  },
  lm: { registerLanguageModelChatProvider: () => ({ dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }) },
  window: {
    showInformationMessage: () => {},
    showWarningMessage: () => undefined,
    showErrorMessage: () => undefined,
    showQuickPick: () => undefined,
    createOutputChannel: () => ({
      appendLine() {},
      append() {},
      show() {},
      dispose() {},
    }),
    createTerminal: () => ({ show() {}, sendText() {} }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue: unknown) => defaultValue,
      update: () => Promise.resolve(),
    }),
  },
  ConfigurationTarget: { Global: 1 },
  LanguageModelTextPart: class {
    constructor(public text: string) {}
  },
}))

describe("extension", () => {
  it("exports activate and deactivate", async () => {
    const mod = await import("./extension")
    expect(typeof mod.activate).toBe("function")
    expect(typeof mod.deactivate).toBe("function")
  })
})
