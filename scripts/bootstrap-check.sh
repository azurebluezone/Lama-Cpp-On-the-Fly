#!/usr/bin/env bash
# Prove the published one-command bootstrap before claiming it works.
#
#   1. local HEAD is exactly origin/main (the code was really pushed);
#   2. raw.githubusercontent.com serves the committed bootstrap.sh byte-for-byte;
#   3. the actual remote one-liner (curl | bash -s -- --fetch-only) downloads the
#      repository tarball into a fresh directory and the tree contains the new
#      relay code, the relay UI and the existing installer.
#
# BOOTSTRAP_PASS only when all three hold in this run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO="${LAMA_REPO:-azurebluezone/Lama-Cpp-On-the-Fly}"
# refs/heads/main is used instead of /main/ because GitHub's raw CDN can serve
# stale bytes for the short form for minutes after a push.
RAW="https://raw.githubusercontent.com/${REPO}/refs/heads/main/scripts/bootstrap.sh"
DEST="${LAMA_BOOTSTRAP_TEST_DIR:-/tmp/opencode/lama-bootstrap-check}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/lama-check.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing $1"; }
need curl
need git
need tar

bash -n scripts/bootstrap.sh || fail "scripts/bootstrap.sh has a shell syntax error"
pass "scripts/bootstrap.sh passes bash -n"

local_head="$(git rev-parse HEAD)"
remote_head="$(git ls-remote "https://github.com/${REPO}.git" refs/heads/main | awk '{print $1}')"
[ -n "$remote_head" ] || fail "origin/main is empty or unreachable"
[ "$local_head" = "$remote_head" ] || fail "local HEAD ${local_head} != origin/main ${remote_head}"
pass "origin/main is at local HEAD ${local_head}"

# Raw GitHub can lag a few seconds after a push; wait for the exact bytes.
served=0
for _ in $(seq 1 15); do
  if curl -fsSL "$RAW" -o "$tmp/bootstrap.sh" && cmp -s "$tmp/bootstrap.sh" scripts/bootstrap.sh; then
    served=1
    break
  fi
  sleep 2
done
[ "$served" = 1 ] || fail "raw.githubusercontent.com does not serve the committed bootstrap.sh"
pass "raw URL serves the committed bootstrap.sh byte-for-byte"

# The real published command, fetch-only so this check stays fast and safe.
rm -rf "$DEST"
fetched=0
for attempt in 1 2 3; do
  rm -rf "$DEST"
  if curl -fsSL "$RAW" | LAMA_DIR="$DEST" LAMA_REF=main bash -s -- --fetch-only >"$tmp/fetch.log" 2>&1; then
    if [ -f "$DEST/src/main.ts" ] &&
      grep -q 'async relayStatus' "$DEST/src/engine.ts" 2>/dev/null &&
      grep -q 'id="relayPanel"' "$DEST/web/index.html" 2>/dev/null &&
      [ -f "$DEST/scripts/install.mjs" ]; then
      fetched=1
      break
    fi
  fi
  sleep 3
done
if [ "$fetched" != 1 ]; then
  cat "$tmp/fetch.log" >&2
  fail "remote bootstrap did not produce the expected tree in ${DEST}"
fi
pass "remote curl | bash --fetch-only produced the relay code + installer in ${DEST}"
grep -q '^FETCH_OK ' "$tmp/fetch.log" || fail "bootstrap did not print FETCH_OK"
pass "bootstrap printed FETCH_OK"

printf 'BOOTSTRAP_PASS\n'
