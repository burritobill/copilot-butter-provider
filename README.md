# Butter for Copilot

Use AWS Bedrock models (Claude, etc.) in GitHub Copilot Chat via a local [Butter](https://github.com/temikus/butter) proxy.

## Features

- **Managed proxy** — auto-downloads and runs Butter locally
- **AWS credential support** — SSO, credential_process (Granted), assume-role, static keys, environment variables
- **Dynamic model discovery** — models are fetched from Butter's `/v1/models` endpoint
- **Streaming** — full streaming support with tool calling
- **Status bar** — real-time process state with quick actions

## Prerequisites

- [VS Code](https://code.visualstudio.com/) 1.103+
- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension
- AWS credentials configured (`~/.aws/config`) with Bedrock access

## Install

The recommended way is the install script, which installs the `.vsix` **and**
enables the proposed API the extension requires (see [Proposed API](#proposed-api)):

```sh
./scripts/install.sh            # uses the newest .vsix in the repo root
./scripts/install.sh path.vsix  # or pass an explicit .vsix
```

Then **restart VS Code**.

### Manual install

Install from `.vsix`:

```sh
code --install-extension butter-copilot-0.0.1.vsix
```

Or use **Extensions: Install from VSIX...** from the command palette.

Then enable the proposed API (see below) and restart VS Code.

### Proposed API

This extension registers as a Copilot language model provider via VS Code's
`chatProvider` proposed API, which is **not yet finalized**. To use it in stable
VS Code, the extension id must be allow-listed in VS Code's `argv.json`:

```jsonc
// ~/.vscode/argv.json  (Insiders: ~/.vscode-insiders/argv.json)
{
  "enable-proposed-api": ["burritobill.butter-copilot"],
}
```

`./scripts/install.sh` does this for you, merging the entry without disturbing
existing settings. A VS Code restart is required after the change.

## Setup

1. Open the command palette (`Cmd+Shift+P`)
2. Run **Butter: Select AWS Profile** to choose your AWS profile
3. Run **Butter: Start Proxy** (or it starts automatically on activation)
4. Open Copilot Chat and select a Butter model from the model picker

## Commands

| Command                    | Description                       |
| -------------------------- | --------------------------------- |
| Butter: Start Proxy        | Start the managed Butter process  |
| Butter: Stop Proxy         | Stop the Butter process           |
| Butter: Restart Proxy      | Restart the Butter process        |
| Butter: Show Logs          | Open the Butter output channel    |
| Butter: Edit Config        | Open the Butter config file       |
| Butter: Select AWS Profile | Choose an AWS profile for Bedrock |
| Butter: Update Binary      | Download the latest Butter binary |
| Butter: Settings           | Open extension settings           |
| Butter: Status Menu        | Quick actions from status bar     |
| Butter: Reset Config       | Regenerate default config         |

## Settings

| Setting                      | Default                 | Description                                                   |
| ---------------------------- | ----------------------- | ------------------------------------------------------------- |
| `butter-copilot.mode`        | `managed`               | `managed` (local process) or `external` (connect to existing) |
| `butter-copilot.externalUrl` | `http://localhost:8080` | URL for external Butter instance                              |
| `butter-copilot.port`        | `8091`                  | Port for managed Butter process                               |
| `butter-copilot.awsProfile`  | `""`                    | AWS profile name                                              |
| `butter-copilot.awsRegion`   | `us-west-2`             | AWS region for Bedrock                                        |
| `butter-copilot.logLevel`    | `info`                  | Log level for Butter output                                   |

## External Mode

To connect to an existing Butter instance instead of running a managed one:

1. Set `butter-copilot.mode` to `external`
2. Set `butter-copilot.externalUrl` to your Butter instance URL
3. Reload VS Code

## License

MIT
