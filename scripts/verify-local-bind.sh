#!/usr/bin/env bash
# Proves the admin /v1 surface is the direct local binding: any model name is
# accepted, masked to the loaded local model, and echoed without truncation.
# No bridge or TCP client-manager is involved.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
WORK="$(mktemp -d /tmp/opencode/verify-local-bind.XXXXXX)" || exit 2
trap 'rm -rf "$WORK"' EXIT

fail() { echo "LOCAL_BIND_FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

TOKEN="$(sed -n 's/^LAMA_ADMIN_TOKEN=//p' .env | head -1)"
[ -n "$TOKEN" ] || fail "no LAMA_ADMIN_TOKEN in .env"
BASE="http://127.0.0.1:5252"

# 1. VS Code auto-approve must be gone.
if [ -f .vscode/settings.json ] && grep -q 'autoApprovePermissions' .vscode/settings.json; then
  fail ".vscode/settings.json still enables autoApprovePermissions"
fi
ok "no VS Code auto-approve setting"

# 2. Docs describe the direct local binding.
grep -q 'Local binding and model masking' README.md || fail "README missing the local binding section"
grep -q 'No TCP handshake' docs/lama-clean.md || fail "docs/lama-clean.md missing the local binding note"
ok "docs describe the local binding"

# 3. Code + tests.
npm run typecheck >"$WORK/typecheck.log" 2>&1 || { tail -20 "$WORK/typecheck.log" >&2; fail "typecheck"; }
ok "typecheck"
npm test >"$WORK/test.log" 2>&1 || { tail -30 "$WORK/test.log" >&2; fail "tests"; }
grep -qE "pass 81" "$WORK/test.log" || { tail -10 "$WORK/test.log" >&2; fail "expected 81 passing tests"; }
ok "81 tests pass"

# 4. The managed engine must be live before the wire checks.
engine_status="$(curl -sS -m 5 -H "authorization: Bearer $TOKEN" "$BASE/api/state" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).engine?.status||"missing")}catch{console.log("bad")}})' \
  || echo bad)"
if [ "$engine_status" != "running" ]; then
  load_code="$(curl -sS -m 90 -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"model_id":"qwen3-1.7b-abliterated","ttl_hours":720}' \
    -o "$WORK/load.json" -w '%{http_code}' "$BASE/api/engine/load")"
  [ "$load_code" = "200" ] || { cat "$WORK/load.json" >&2; fail "engine load -> $load_code"; }
fi
ok "local engine is running"

# 5. Buffered request: the client name differs in length from the local alias,
#    so a stale content-length would truncate the JSON.
code="$(curl -sS -m 30 -H 'content-type: application/json' \
  -d '{"model":"opencode/flint-40b-free","messages":[{"role":"user","content":"Say OK"}],"max_tokens":3,"temperature":0,"stream":false,"chat_template_kwargs":{"enable_thinking":false}}' \
  -o "$WORK/buffered.json" -w '%{http_code}' "$BASE/v1/chat/completions")"
[ "$code" = "200" ] || { cat "$WORK/buffered.json" >&2; fail "buffered chat -> $code"; }
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(j.model!=="opencode/flint-40b-free")process.exit(1); if(!j.choices?.[0]?.finish_reason)process.exit(2); console.log("buffered echo="+j.model+" finish="+j.choices[0].finish_reason)' "$WORK/buffered.json" \
  || fail "buffered response is truncated or does not echo the requested model"
ok "buffered free-model chat echoes the client name and parses"

# 6. The request log must show the local HTTP transport and a real local row.
curl -sS -m 5 -H "authorization: Bearer $TOKEN" "$BASE/api/requests?limit=1" -o "$WORK/log.json" \
  || fail "GET /api/requests failed"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0]; if(r.model_key!=="opencode/flint-40b-free")process.exit(1); if(r.transport_id!=="http")process.exit(2); if(!r.model_id)process.exit(3); console.log("log transport="+r.transport_id+" model_id="+r.model_id)' "$WORK/log.json" \
  || fail "request log is not bound to the local http transport"
ok "request log binds the free-model name to the local engine"

# 7. Streaming must keep the OpenAI contract OpenCode expects.
curl -sS -N -m 30 -H 'content-type: application/json' \
  -d '{"model":"opencode/flint-40b-free","messages":[{"role":"user","content":"Say OK"}],"max_tokens":3,"temperature":0,"stream":true,"chat_template_kwargs":{"enable_thinking":false}}' \
  "$BASE/v1/chat/completions" -o "$WORK/stream.txt" || fail "stream request failed"
grep -q 'opencode/flint-40b-free' "$WORK/stream.txt" || fail "stream does not echo the requested model"
grep -q '"finish_reason":"length"' "$WORK/stream.txt" || fail "stream has no finish_reason"
grep -q '^data: \[DONE\]' "$WORK/stream.txt" || fail "stream has no data: [DONE] terminator"
ok "stream echoes the name and ends with finish_reason + data: [DONE]"

# 8. The change is committed and pushed.
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "HEAD is not pushed to origin/main"
ok "HEAD matches origin/main"

echo "LOCAL_BIND_OK"
