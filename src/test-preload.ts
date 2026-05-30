import { mock } from "bun:test"

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
    value: string
    constructor(value: string) {
      this.value = value
    }
  },
  LanguageModelToolCallPart: class {
    callId: string
    name: string
    input: object
    constructor(callId: string, name: string, input: object) {
      this.callId = callId
      this.name = name
      this.input = input
    }
  },
  LanguageModelChatToolMode: { Auto: 0, Required: 1 },
  CancellationTokenSource: class {
    token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    }
    cancel() {
      this.token.isCancellationRequested = true
    }
    dispose() {}
  },
}))
