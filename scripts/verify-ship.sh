#!/usr/bin/env bash
# Release gate for the public release of Lama-Cpp-On-the-Fly.
#
# It proves, against the running machine and the published remote:
#   - the code is committed and the same commit is on refs/heads/main
#   - every response carries the system identity, the version and the protocol
#   - the engine runs on a llama.cpp built-in chat template (no custom jinja file)
#   - a GBNF grammar constrains the generation natively
#   - the logs hold one file per transport and one per model
#
# Prints SHIP_OK only when every check passes.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
WORK="$(mktemp -d /tmp/opencode/verify-ship.XXXXXX)" || exit 2
trap 'rm -rf "$WORK"' EXIT

fail() { echo "SHIP_FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

REMOTE="${LAMA_REMOTE:-https://github.com/azurebluezone/Lama-Cpp-On-the-Fly.git}"
BRANCH="${LAMA_BRANCH:-main}"
GATEWAY="${LAMA_GATEWAY:-http://127.0.0.1:5252}"

TOKEN="$(sed -n 's/^LAMA_ADMIN_TOKEN=//p' .env 2>/dev/null | head -1)"
[ -n "$TOKEN" ] || fail "no LAMA_ADMIN_TOKEN in .env"

# ---------- 1. the published commit is the local commit ----------
git rev-parse --git-dir >/dev/null 2>&1 || fail "not a git working tree"
LOCAL_SHA="$(git rev-parse HEAD 2>/dev/null)" || fail "cannot read HEAD"
REMOTE_SHA="$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}')"
[ -n "$REMOTE_SHA" ] || fail "no refs/heads/$BRANCH on $REMOTE"
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] || fail "HEAD $LOCAL_SHA is not the published $REMOTE_SHA"
ok "published commit matches local HEAD ($LOCAL_SHA)"

# ---------- 2. the identity travels on every response ----------
HEADERS="$(curl -sS -m 15 -D - -o /dev/null "$GATEWAY/healthz" 2>/dev/null)"
grep -qi "^x-system-identity: " <<<"$HEADERS" || fail "no x-system-identity header"
grep -qi "^x-system-version: " <<<"$HEADERS" || fail "no x-system-version header"
grep -qi "^x-system-protocol: " <<<"$HEADERS" || fail "no x-system-protocol header"
IDENTITY="$(grep -i '^x-system-identity:' <<<"$HEADERS" | awk '{print $2}' | tr -d '\r')"
VERSION="$(grep -i '^x-system-version:' <<<"$HEADERS" | awk '{print $2}' | tr -d '\r')"
PROTOCOL="$(grep -i '^x-system-protocol:' <<<"$HEADERS" | awk '{print $2}' | tr -d '\r')"
ok "identity headers present (identity=$IDENTITY version=$VERSION protocol=$PROTOCOL)"

# ---------- 3. the engine runs on a llama.cpp built-in chat template ----------
ENGINE_PID="$(curl -sS -m 15 -H "authorization: Bearer $TOKEN" "$GATEWAY/api/engine/status" 2>/dev/null \
  | sed -n 's/.*"pid":\([0-9]*\).*/\1/p' | head -1)"
[ -n "$ENGINE_PID" ] || fail "no engine pid in the engine status"
CMDLINE="$(tr '\0' ' ' < "/proc/$ENGINE_PID/cmdline" 2>/dev/null)"
[ -n "$CMDLINE" ] || fail "cannot read the engine command line of pid $ENGINE_PID"
grep -q -- "--chat-template-file" <<<"$CMDLINE" && fail "the engine still loads a custom jinja template file"
grep -q -- "--jinja" <<<"$CMDLINE" || fail "the engine does not run the jinja chat engine"
ok "engine uses a llama.cpp built-in chat template (no --chat-template-file)"

# ---------- 4. the GBNF grammar constrains the generation natively ----------
GRAMMAR='root ::= "{\"answer\": \"" [a-z]+ "\"}"'
ANSWER="$(curl -sS -m 180 -X POST "$GATEWAY/v1/chat/completions" \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d "{\"model\":\"deepseek-v4-pro\",\"max_tokens\":48,\"temperature\":0,\"messages\":[{\"role\":\"user\",\"content\":\"Say hello\"}],\"grammar\":\"$GRAMMAR\"}" 2>/dev/null)"
[ -n "$ANSWER" ] || fail "the grammar-constrained request returned nothing"
CONTENT="$(sed -n 's/.*"content":"\([^"]*\)".*/\1/p' <<<"$ANSWER" | head -1)"
REASONING="$(sed -n 's/.*"reasoning_content":"\([^"]*\)".*/\1/p' <<<"$ANSWER" | head -1)"
TEXT="$CONTENT$REASONING"
grep -qE '^\{"answer": "[a-z]+"\}$' <<<"$TEXT" || fail "the grammar did not constrain the answer: $TEXT"
ok "GBNF grammar constrains the generation natively"

# ---------- 5. the logs hold one file per transport and one per model ----------
LOGDIR="${LAMA_LOG_DIR:-$ROOT/logs}"
[ -d "$LOGDIR" ] || fail "no logs directory at $LOGDIR"
ls "$LOGDIR"/transport-*.log >/dev/null 2>&1 || fail "no per-transport log file in $LOGDIR"
ls "$LOGDIR"/model-*.log >/dev/null 2>&1 || fail "no per-model log file in $LOGDIR"
ENTRY="$(tail -1 "$LOGDIR"/transport-*.log 2>/dev/null | head -1)"
for field in model protocol client mcp_tool_executed duration_ms prompt_tokens completion_tokens total_tokens; do
  grep -q "\"$field\"" <<<"$ENTRY" || fail "the log entry has no $field field"
done
ok "per-transport and per-model logs carry model, protocol, client, MCP, duration and tokens"

# ---------- 6. no invisible watermark in the published files ----------
npm test -- test/watermark.test.ts >"$WORK/watermark.log" 2>&1 || {
  tail -20 "$WORK/watermark.log" >&2; fail "an invisible watermark character is present"; }
ok "no invisible watermark characters in the repository"

# ---------- 7. the code itself is green ----------
npm run typecheck >"$WORK/typecheck.log" 2>&1 || { tail -20 "$WORK/typecheck.log" >&2; fail "typecheck"; }
npm test >"$WORK/test.log" 2>&1 || { tail -30 "$WORK/test.log" >&2; fail "tests"; }
ok "typecheck and tests pass"

echo "grammar=native chat_template=builtin"
echo "identity=$IDENTITY version=$VERSION protocol=$PROTOCOL"
echo "commit=$LOCAL_SHA remote=$REMOTE branch=$BRANCH"
echo "SHIP_OK"
