<p align="center">
  <img src="public/copilot_butter.svg" alt="Butter logo" width="200">
</p>

# Butter for Copilot

Use AWS Bedrock models (Claude, etc.) in GitHub Copilot Chat via a local [Butter](https://github.com/temikus/butter) proxy.

## Install

```sh
curl -fsSL https://github.com/burritobill/copilot-butter-provider/releases/latest/download/butter-copilot.tar.gz | tar xz && cd butter-copilot-* && ./install.sh
```

Then **restart VS Code**.

> **Prerequisites:** VS Code 1.103+, [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot), and AWS credentials (`~/.aws/config`) with Bedrock access.

## What it does

The extension registers as a Copilot language model provider, so Bedrock models (Claude Sonnet, Opus, Haiku, etc.) appear in the Copilot Chat model picker alongside the default models. It manages a local [Butter](https://github.com/temikus/butter) proxy that translates between Copilot's API and AWS Bedrock.

- **Zero config** — auto-downloads and manages the Butter binary
- **AWS credentials** — SSO, credential_process (Granted), assume-role, static keys, env vars
- **Dynamic models** — discovers available models from Bedrock automatically
- **Streaming + tools** — full support for streaming responses and tool calling
- **Status bar** — shows proxy state with quick actions

## Setup

1. Open the command palette (`Cmd+Shift+P`)
2. Run **Butter: Select AWS Profile** to choose your AWS profile
3. The proxy starts automatically — select a Butter model from the Copilot Chat model picker

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

## Configuration

| Setting                               | Default                 | Description                                                   |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `butter-copilot.mode`                 | `managed`               | `managed` (local process) or `external` (connect to existing) |
| `butter-copilot.externalUrl`          | `http://localhost:8080` | URL for external Butter instance                              |
| `butter-copilot.port`                 | `8091`                  | Port for managed Butter process                               |
| `butter-copilot.awsProfile`           | —                       | AWS profile name                                              |
| `butter-copilot.awsRegion`            | `us-west-2`             | AWS region for Bedrock                                        |
| `butter-copilot.logLevel`             | `info`                  | Log level (`debug` / `info` / `warn` / `error`)               |
| `butter-copilot.logBodies`            | `false`                 | Log request/response bodies (may expose secrets)              |
| `butter-copilot.useInferenceProfiles` | `false`                 | Use custom inference profiles for cost attribution            |

## External mode

To connect to an existing Butter instance instead of running a managed one:

```jsonc
// .vscode/settings.json
{
  "butter-copilot.mode": "external",
  "butter-copilot.externalUrl": "http://your-butter-host:8080",
}
```

## How the install works

The extension uses VS Code's `chatProvider` proposed API, which requires the extension ID to be allow-listed in `~/.vscode/argv.json`. The install script handles this automatically — it installs the `.vsix` and merges the allow-list entry without disturbing existing settings.

<details>
<summary>Manual install</summary>

```sh
code --install-extension butter-copilot-*.vsix
```

Then add to `~/.vscode/argv.json` (or `~/.vscode-insiders/argv.json`):

```jsonc
{
  "enable-proposed-api": ["burritobill.butter-copilot"],
}
```

Restart VS Code.

</details>

## License

MIT
