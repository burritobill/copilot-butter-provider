#!/usr/bin/env bats
#
# Tests for enable_proposed_api in argv-merge.sh — the idempotent JSONC merge
# that adds an extension id to VS Code's argv.json "enable-proposed-api" array.

setup() {
  # Source the function under test.
  load_dir="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
  # shellcheck source=argv-merge.sh
  . "$load_dir/argv-merge.sh"

  EXT="burritobill.butter-copilot"
  ARGV="$BATS_TEST_TMPDIR/argv.json"
}

teardown() {
  rm -f "$BATS_TEST_TMPDIR"/argv.json.bak.* 2>/dev/null || true
}

# Count occurrences of the quoted "enable-proposed-api" key in the file.
key_count() {
  grep -c '"enable-proposed-api"' "$ARGV"
}

@test "creates a fresh file when argv.json is missing" {
  run enable_proposed_api "$EXT" "$ARGV"
  [ "$status" -eq 0 ]
  [ -f "$ARGV" ]
  grep -q "\"$EXT\"" "$ARGV"
  # Header comment is present.
  grep -q "PLEASE DO NOT CHANGE" "$ARGV"
  [ "$(key_count)" -eq 1 ]
}

@test "creates a fresh file when argv.json is whitespace-only" {
  printf '   \n\t\n' >"$ARGV"
  run enable_proposed_api "$EXT" "$ARGV"
  [ "$status" -eq 0 ]
  grep -q "\"$EXT\"" "$ARGV"
  [ "$(key_count)" -eq 1 ]
}

@test "is idempotent when id already present" {
  cat >"$ARGV" <<'EOF'
// header
{
  "enable-proposed-api": ["burritobill.butter-copilot", "other.ext"]
}
EOF
  run enable_proposed_api "$EXT" "$ARGV"
  [ "$status" -eq 0 ]
  [[ "$output" == *"already enabled"* ]]
  # Unchanged: still exactly one key, both ids intact.
  [ "$(key_count)" -eq 1 ]
  grep -q '"other.ext"' "$ARGV"
}

@test "merges into an existing multi-line array without duplicating the key" {
  cat >"$ARGV" <<'EOF'
// This configuration file allows you to pass permanent command line arguments to VS Code.
{
  "enable-crash-reporter": true,
  "crash-reporter-id": "abc-123",
  "enable-proposed-api": [
    "some.existing-ext"
  ]
}
EOF
  run enable_proposed_api "$EXT" "$ARGV"
  [ "$status" -eq 0 ]
  # Exactly one key (no duplicate inserted).
  [ "$(key_count)" -eq 1 ]
  # Both the new and existing ids are present.
  grep -q "\"$EXT\"" "$ARGV"
  grep -q '"some.existing-ext"' "$ARGV"
  # Other keys preserved.
  grep -q '"enable-crash-reporter"' "$ARGV"
  grep -q '"crash-reporter-id"' "$ARGV"
}

@test "merges into an existing single-line array without duplicating the key" {
  cat >"$ARGV" <<'EOF'
// header
{
  "enable-crash-reporter": true,
  "enable-proposed-api": ["some.existing-ext"]
}
EOF
  run enable_proposed_api "$EXT" "$ARGV"
  [ "$status" -eq 0 ]
  [ "$(key_count)" -eq 1 ]
  grep -q "\"$EXT\"" "$ARGV"
  grep -q '"some.existing-ext"' "$ARGV"
}

@test "merges into an empty array" {
  cat >"$ARGV" <<'EOF'
// header
{
  "enable-crash-reporter": true,
  "enable-proposed-api": []
}
EOF
  run enable_proposed_api "$EXT" "$ARGV"
  [ "$status" -eq 0 ]
  [ "$(key_count)" -eq 1 ]
  grep -q "\"$EXT\"" "$ARGV"
}

@test "inserts the key when absent, preserving other settings and comments" {
  cat >"$ARGV" <<'EOF'
// This configuration file allows you to pass permanent command line arguments to VS Code.
//
// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT
{
  "enable-crash-reporter": true,
  "crash-reporter-id": "abc-123"
}
EOF
  run enable_proposed_api "$EXT" "$ARGV"
  [ "$status" -eq 0 ]
  [ "$(key_count)" -eq 1 ]
  grep -q "\"$EXT\"" "$ARGV"
  grep -q '"enable-crash-reporter"' "$ARGV"
  grep -q '"crash-reporter-id"' "$ARGV"
  grep -q "PLEASE DO NOT CHANGE" "$ARGV"
}

@test "does not false-positive on a substring id" {
  # A different id that contains our id as a prefix should NOT count as present.
  cat >"$ARGV" <<'EOF'
// header
{
  "enable-proposed-api": ["burritobill.butter-copilot-extra"]
}
EOF
  run enable_proposed_api "$EXT" "$ARGV"
  [ "$status" -eq 0 ]
  # Our exact quoted id must now be present in addition to the longer one.
  grep -q "\"$EXT\"," "$ARGV" || grep -q "\"$EXT\"]" "$ARGV"
  grep -q '"burritobill.butter-copilot-extra"' "$ARGV"
  [ "$(key_count)" -eq 1 ]
}

@test "creates a backup when modifying an existing file" {
  cat >"$ARGV" <<'EOF'
// header
{
  "enable-crash-reporter": true
}
EOF
  run enable_proposed_api "$EXT" "$ARGV"
  [ "$status" -eq 0 ]
  # A timestamped backup should exist.
  ls "$ARGV".bak.* >/dev/null 2>&1
}

@test "returns usage error when arguments are missing" {
  run enable_proposed_api "" ""
  [ "$status" -ne 0 ]
}
