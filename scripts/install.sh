#!/usr/bin/env bash
#
# Install the Butter for Copilot extension and enable the proposed API it needs.
#
# The extension relies on VS Code's `chatProvider` proposed API, which is not yet
# finalized. To use a proposed API in stable VS Code, the extension id must be
# allow-listed under `enable-proposed-api` in VS Code's `argv.json`. This script
# installs the packaged `.vsix` and adds that allow-list entry idempotently
# (preserving any existing entries and the file's comments).
#
# This script is shipped two ways and works in both:
#   - In the repo:     scripts/install.sh + scripts/argv-merge.sh; the .vsix
#                      lives in the repo root.
#   - In the release:  a flat tarball with install.sh + argv-merge.sh + the
#                      .vsix all side by side. Untar and run ./install.sh.
#
# Usage:
#   ./install.sh [path/to/extension.vsix]
#
# Environment overrides:
#   CODE_CLI    The VS Code CLI to use (default: auto-detect `code`, then `code-insiders`).
#   ARGV_JSON   Path to argv.json (default: derived from the CLI / standard location).

set -euo pipefail

EXTENSION_ID="burritobill.butter-copilot"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source the JSONC merge helper from the same directory as this script. This
# works both in the repo (scripts/) and in the flat release tarball.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=argv-merge.sh
. "${script_dir}/argv-merge.sh"

# Print the path to the newest *.vsix directly inside <dir> (non-recursive), or
# nothing if there is none. Uses find + stat instead of `ls -t` so filenames
# with non-alphanumeric characters can't break selection. Handles both BSD
# (macOS) and GNU (Linux) stat, since VS Code runs on both.
newest_vsix() {
  local dir="$1"
  local stat_fmt
  if stat -f '%m' "${dir}" >/dev/null 2>&1; then
    stat_fmt=(stat -f '%m %N') # BSD / macOS
  else
    stat_fmt=(stat -c '%Y %n') # GNU / Linux
  fi
  find "${dir}" -maxdepth 1 -type f -name '*.vsix' -print0 2>/dev/null |
    xargs -0 "${stat_fmt[@]}" 2>/dev/null |
    sort -rn |
    head -n1 |
    cut -d' ' -f2-
}

main() {
  # --- Resolve the VS Code CLI --------------------------------------------------

  local code_cli="${CODE_CLI:-}"
  if [[ -z "${code_cli}" ]]; then
    if command -v code >/dev/null 2>&1; then
      code_cli="code"
    elif command -v code-insiders >/dev/null 2>&1; then
      code_cli="code-insiders"
    else
      echo "error: could not find the VS Code CLI ('code' or 'code-insiders') on your PATH." >&2
      echo "       Open VS Code and run 'Shell Command: Install \"code\" command in PATH', then retry." >&2
      echo "       Or set CODE_CLI to the full path of your VS Code CLI." >&2
      exit 1
    fi
  fi

  # --- Resolve the VSIX to install ----------------------------------------------
  #
  # Search order: explicit arg → newest .vsix next to this script (tarball) →
  # newest .vsix in the repo root (when run from a clone).

  local vsix_path="${1:-}"
  if [[ -z "${vsix_path}" ]]; then
    vsix_path="$(newest_vsix "${script_dir}")"
  fi
  if [[ -z "${vsix_path}" ]]; then
    vsix_path="$(newest_vsix "${script_dir}/..")"
  fi
  if [[ -z "${vsix_path}" ]]; then
    echo "error: no .vsix found next to install.sh or in the repo root." >&2
    echo "       Build one with 'bun run package' or pass a path: ./install.sh path.vsix" >&2
    exit 1
  fi
  if [[ ! -f "${vsix_path}" ]]; then
    echo "error: VSIX not found: ${vsix_path}" >&2
    exit 1
  fi

  # --- Resolve argv.json --------------------------------------------------------
  #
  # VS Code stores argv.json in the user data directory:
  #   stable:   ~/.vscode/argv.json
  #   insiders: ~/.vscode-insiders/argv.json
  # The CLI name tells us which variant we're targeting.

  local argv_json="${ARGV_JSON:-}"
  if [[ -z "${argv_json}" ]]; then
    case "${code_cli}" in
      *insiders*) argv_json="${HOME}/.vscode-insiders/argv.json" ;;
      *) argv_json="${HOME}/.vscode/argv.json" ;;
    esac
  fi

  # --- Install the extension ----------------------------------------------------

  echo "Installing extension from: ${vsix_path}"
  "${code_cli}" --install-extension "${vsix_path}" --force

  # --- Enable the proposed API --------------------------------------------------

  echo "Ensuring '${EXTENSION_ID}' is allow-listed for proposed APIs in: ${argv_json}"
  enable_proposed_api "${EXTENSION_ID}" "${argv_json}"

  echo
  echo "Done. Restart VS Code for the proposed-API change to take effect."
}

# Only run main when executed, not when sourced (e.g. by BATS tests). This keeps
# the script a single self-contained entry point while allowing the functions in
# argv-merge.sh to be unit-tested independently.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
