#!/usr/bin/env bash
#
# enable_proposed_api — idempotently add an extension id to the
# "enable-proposed-api" array in VS Code's argv.json (JSONC).
#
# argv.json is JSONC (comments + possible trailing commas). We avoid a JSON
# parser dependency (node/jq/python may be absent — the VS Code CLI does not
# expose a runtime) and instead do a targeted, structure-preserving edit with
# awk. Comments, other keys, and formatting are preserved because we only
# insert; we never reserialize the document.
#
# Handled cases:
#   1. id already present (quoted)        -> no change (idempotent)
#   2. "enable-proposed-api" key present  -> insert id as first array element
#   3. key absent                         -> insert the key after the first "{"
#   4. file missing / empty               -> write a fresh file with the header
#
# Usage:
#   enable_proposed_api <extension_id> <argv_json_path>
#
# Returns 0 on success (including the idempotent no-op), non-zero on failure.
# Writes human-readable progress to stdout and errors to stderr.

# Default contents VS Code writes, used only when the file is missing/empty.
# The literal __EXT_ID__ is substituted by the caller.
_argv_default_template() {
  cat <<'EOF'
// This configuration file allows you to pass permanent command line arguments to VS Code.
// Only a subset of arguments is currently supported to reduce the likelihood of breaking
// the installation.
//
// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT
//
// NOTE: Changing this file requires a restart of VS Code.
{
  "enable-proposed-api": ["__EXT_ID__"]
}
EOF
}

enable_proposed_api() {
  local ext_id="$1"
  local argv_json="$2"

  if [[ -z "${ext_id}" || -z "${argv_json}" ]]; then
    echo "enable_proposed_api: usage: enable_proposed_api <extension_id> <argv_json_path>" >&2
    return 2
  fi

  mkdir -p "$(dirname "${argv_json}")"

  # Case 4: missing or whitespace-only file — write a fresh one.
  if [[ ! -s "${argv_json}" ]] || ! grep -q '[^[:space:]]' "${argv_json}" 2>/dev/null; then
    local template
    template="$(_argv_default_template)"
    printf '%s\n' "${template//__EXT_ID__/${ext_id}}" >"${argv_json}"
    echo "Created ${argv_json} with '${ext_id}' enabled."
    return 0
  fi

  # Case 1: already enabled (match the quoted id to avoid substring false positives).
  if grep -q "\"${ext_id}\"" "${argv_json}"; then
    echo "'${ext_id}' is already enabled — no change needed."
    return 0
  fi

  # Back up before editing.
  local backup
  backup="${argv_json}.bak.$(date +%Y%m%d%H%M%S)"
  cp "${argv_json}" "${backup}"

  local tmp
  tmp="$(mktemp)"

  # Decide the strategy up front with grep, then run a focused awk pass. We do
  # NOT let awk decide between "merge into array" and "insert new key"
  # mid-stream — the top-level "{" always precedes the key, so a brace-based
  # fallback would fire first and wrongly insert a duplicate key.
  if grep -q '"enable-proposed-api"' "${argv_json}"; then
    # Case 2: key exists — insert id as the first element of its array.
    awk -v id="${ext_id}" '
      BEGIN { inserted = 0; seeking = 0 }
      inserted == 1 { print; next }

      seeking == 1 {
        if (index($0, "[") > 0) {
          pos = index($0, "[")
          before = substr($0, 1, pos)
          after = substr($0, pos + 1)
          if (after ~ /^[[:space:]]*\]/) {
            print before "\"" id "\"" after
          } else {
            print before "\"" id "\", " after
          }
          inserted = 1
          next
        }
        print
        next
      }

      index($0, "\"enable-proposed-api\"") > 0 {
        if (index($0, "[") > 0) {
          pos = index($0, "[")
          before = substr($0, 1, pos)
          after = substr($0, pos + 1)
          if (after ~ /^[[:space:]]*\]/) {
            print before "\"" id "\"" after
          } else {
            print before "\"" id "\", " after
          }
          inserted = 1
          next
        }
        seeking = 1
        print
        next
      }

      { print }
    ' "${argv_json}" >"${tmp}"
  else
    # Case 3: key absent — insert a new member right after the first "{".
    awk -v id="${ext_id}" '
      BEGIN { inserted = 0 }
      inserted == 0 && index($0, "{") > 0 {
        pos = index($0, "{")
        before = substr($0, 1, pos)
        after = substr($0, pos + 1)
        print before
        printf "  \"enable-proposed-api\": [\"%s\"],\n", id
        if (after ~ /[^[:space:]]/) print after
        inserted = 1
        next
      }
      { print }
    ' "${argv_json}" >"${tmp}"
  fi

  # Sanity: ensure the id made it in; otherwise restore and ask for manual edit.
  if grep -q "\"${ext_id}\"" "${tmp}"; then
    mv "${tmp}" "${argv_json}"
    echo "Added '${ext_id}' to enable-proposed-api (backup: ${backup})."
    return 0
  fi

  rm -f "${tmp}"
  echo "error: could not safely edit ${argv_json}." >&2
  echo "       Add this manually and restart VS Code:" >&2
  echo "         \"enable-proposed-api\": [\"${ext_id}\"]" >&2
  echo "       (your file is unchanged; backup at ${backup})" >&2
  return 1
}
