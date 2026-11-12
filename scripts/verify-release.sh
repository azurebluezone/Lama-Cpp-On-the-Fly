#!/usr/bin/env bash
# Release gate for the documented local stack:
#   https://localhost        Caddy TLS edge (verified against certs/localhost-cert.pem)
#     -> 127.0.0.1:5252      gateway: API + admin UI + SSE
#     -> 127.0.0.1:9932      stock llama.cpp engine (HTTP/UDS)
#
# Prints VERIFY_OK only when every check passes. Any failure prints VERIFY_FAIL
# and exits non-zero; no check is skipped silently.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
WORK="$(mktemp -d /tmp/opencode/verify-release.XXXXXX)" || exit 2
trap 'rm -rf "$WORK"' EXIT

fail() { echo "VERIFY_FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# ---------- 1. code + tests ----------
npm run typecheck >"$WORK/typecheck.log" 2>&1 || { tail -20 "$WORK/typecheck.log" >&2; fail "typecheck"; }
ok "typecheck"

npm test >"$WORK/test.log" 2>&1 || { tail -30 "$WORK/test.log" >&2; fail "tests"; }
grep -qE "pass 103" "$WORK/test.log" || { tail -10 "$WORK/test.log" >&2; fail "expected 103 passing tests"; }
ok "103 tests pass"

# ---------- 2. docs must describe this stack ----------
grep -q '9932' README.md || fail "README does not document engine 9932"
grep -q '9934' README.md || fail "README does not document the blue-green spare 9934"
grep -q '103 tests' README.md || fail "README test count is stale"
grep -q 'retry: 3000' README.md || fail "README SSE retry is stale"
grep -q 'Caddy' README.md || fail "README has no Caddy TLS section"
grep -q '9932' docs/lama-clean.md || fail "docs/lama-clean.md does not document engine 9932"
grep -q '9934' docs/lama-clean.md || fail "docs/lama-clean.md does not document the blue-green spare 9934"
grep -q '103 tests' docs/lama-clean.md || fail "docs/lama-clean.md test count is stale"
! grep -q 'server/README.md' scripts/lamactl.mjs || fail "lamactl still points at missing server/README.md"
[ -f Caddyfile ] || fail "Caddyfile missing"
[ -x scripts/caddy.sh ] || fail "scripts/caddy.sh is not executable"
ok "docs truth checks"

# ---------- 2c. endpoints ----------
CERT="$ROOT/certs/localhost-cert.pem"
BASE="https://127.0.0.1:9931"
BASE_HTTP="http://127.0.0.1:5252"
TOKEN="$(sed -n 's/^LAMA_ADMIN_TOKEN=//p' .env | head -1)"
[ -n "$TOKEN" ] || fail "no LAMA_ADMIN_TOKEN in .env"
[ -f "$CERT" ] || fail "missing $CERT"

# ---------- 2b. managed engine must be live for the wire-level checks ----------
engine_status="$(curl -sS -m 10 -H "authorization: Bearer $TOKEN" "$BASE_HTTP/api/state" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).engine?.status||"missing")}catch{console.log("bad")}})' \
  || echo bad)"
if [ "$engine_status" != "running" ]; then
  load_code="$(curl -sS -m 150 -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"model_id":"deepseek-v4-pro","ttl_hours":720}' \
    -o "$WORK/load.json" -w '%{http_code}' "$BASE_HTTP/api/engine/load")"
  [ "$load_code" = "200" ] || { cat "$WORK/load.json" >&2; fail "engine load -> $load_code"; }
  ok "engine loaded for the wire checks"
else
  ok "engine already running for the wire checks"
fi

# ---------- 3. TLS edge with full verification (no -k) ----------
read -r health verify < <(curl -sS --cacert "$CERT" -o "$WORK/healthz.json" -w '%{http_code} %{ssl_verify_result}\n' "$BASE/healthz") \
  || fail "HTTPS /healthz did not complete"
[ "$health" = "200" ] || fail "HTTPS /healthz -> $health"
[ "$verify" = "0" ] || fail "TLS verification result is $verify, expected 0"
grep -q '"ok":true' "$WORK/healthz.json" || fail "HTTPS /healthz body is not ok:true"
ok "HTTPS /healthz 200, ssl_verify_result=0"

read -r models verify < <(curl -sS --cacert "$CERT" -H "authorization: Bearer $TOKEN" \
  -o "$WORK/models.json" -w '%{http_code} %{ssl_verify_result}\n' "$BASE/v1/models") \
  || fail "HTTPS /v1/models did not complete"
[ "$models" = "200" ] || fail "HTTPS /v1/models -> $models"
[ "$verify" = "0" ] || fail "/v1/models TLS verification result is $verify"
node -e 'const j=require(process.argv[1]); if(!Array.isArray(j.data)||j.data.length===0) process.exit(1)' "$WORK/models.json" \
  || fail "/v1/models returned no model"
ok "HTTPS /v1/models 200 with a loaded model"

read -r chat verify < <(curl -sS --cacert "$CERT" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"Reply with the single word OK."}],"max_tokens":8,"temperature":0}' \
  -o "$WORK/chat.json" -w '%{http_code} %{ssl_verify_result}\n' "$BASE/v1/chat/completions") \
  || fail "HTTPS chat did not complete"
[ "$chat" = "200" ] || { cat "$WORK/chat.json" >&2; fail "HTTPS chat -> $chat"; }
[ "$verify" = "0" ] || fail "chat TLS verification result is $verify"
node -e 'const j=require(process.argv[1]); if(!j.choices?.[0]?.message) process.exit(1)' "$WORK/chat.json" \
  || fail "chat response has no choice"
ok "HTTPS /v1/chat/completions 200"

read -r tool verify < <(curl -sS --cacert "$CERT" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"read_file","arguments":{"path":"README.md"}}' \
  -o "$WORK/tool.json" -w '%{http_code} %{ssl_verify_result}\n' "$BASE/api/tools/call") \
  || fail "HTTPS /api/tools/call did not complete"
[ "$tool" = "200" ] || { cat "$WORK/tool.json" >&2; fail "HTTPS /api/tools/call -> $tool"; }
[ "$verify" = "0" ] || fail "tool call TLS verification result is $verify"
node -e 'const j=require(process.argv[1]); if(j.name!=="read_file"||typeof j.result?.content!=="string"||j.result.content.length===0) process.exit(1)' "$WORK/tool.json" \
  || fail "tool call result is not a read_file payload"
ok "HTTPS /api/tools/call 200 (read_file)"

echo "VERIFY_OK"
