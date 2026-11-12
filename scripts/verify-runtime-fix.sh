#!/usr/bin/env bash
# Regression gate for the engine-native https hang, the legacy manager and the
# Runtime tab. Prints RUNTIME_FIX_OK only when every check below passes.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
WORK="$(mktemp -d /tmp/opencode/verify-runtime-fix.XXXXXX)" || exit 2
trap 'rm -rf "$WORK"' EXIT

fail() { echo "RUNTIME_FIX_FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

TOKEN="$(sed -n 's/^LAMA_ADMIN_TOKEN=//p' .env | head -1)"
[ -n "$TOKEN" ] || fail "no LAMA_ADMIN_TOKEN in .env"
BASE="http://127.0.0.1:5252"

# 1. Admin must stop promptly. Open SSE streams used to hold SIGTERM until
#    systemd killed the unit after TimeoutStopSec=20.
start=$(date +%s%3N)
systemctl --user restart lama-gateway || fail "systemctl --user restart lama-gateway failed"
code=""
for _ in $(seq 1 50); do
  code=$(curl -sS -m 1 -o /dev/null -w '%{http_code}' "$BASE/healthz" 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 0.1
done
[ "$code" = "200" ] || fail "admin /healthz did not return 200 after restart"
elapsed=$(( $(date +%s%3N) - start ))
[ "$elapsed" -lt 5000 ] || fail "admin restart took ${elapsed}ms (expected <5000ms)"
ok "admin restart ${elapsed}ms, /healthz 200"

# 2. Full release gate: typecheck, 81 tests, docs truth, verified HTTPS, tool call.
bash scripts/verify-release.sh || fail "release gate failed"
ok "release gate VERIFY_OK"

# 3. The engine-native https row must fail fast instead of attempting a TLS
#    handshake against the plain-HTTP engine.
read -r status seconds < <(curl -sS -m 5 -o "$WORK/https.json" -w '%{http_code} %{time_total}\n' \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"transport_id":"https","messages":[{"role":"user","content":"hi"}],"max_tokens":1,"stream":false}' \
  "$BASE/api/chat") || fail "https transport request did not finish"
[ "$status" = "400" ] || { cat "$WORK/https.json" >&2; fail "https transport returned $status, expected 400"; }
awk -v t="$seconds" 'BEGIN { exit !(t < 2.0) }' || fail "https transport took ${seconds}s, expected <2s"
grep -q 'engine-native TLS is disabled' "$WORK/https.json" || { cat "$WORK/https.json" >&2; fail "https transport error message is not actionable"; }
ok "https transport rejected in ${seconds}s with 400"

# 4. The legacy lama-mgmt manager must be stopped and disabled.
active="$(systemctl --user is-active lama-mgmt.service 2>/dev/null || true)"
enabled="$(systemctl --user is-enabled lama-mgmt.service 2>/dev/null || true)"
case "$active" in
  inactive | failed) ;;
  *) fail "lama-mgmt.service is $active (expected inactive/failed)" ;;
esac
[ "$enabled" = "disabled" ] || fail "lama-mgmt.service is $enabled (expected disabled)"
ok "legacy lama-mgmt.service inactive/disabled"

# 5. The engine must be live before the runtime state/relay/mmap assertions: a
#    fresh admin boot resumes a running engine, but a cold/expired state does
#    not, so bring the managed model up when it is down.
engine_status="$(curl -sS -m 10 -H "authorization: Bearer $TOKEN" "$BASE/api/state" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).engine?.status||"missing")}catch{console.log("bad")}})' \
  || echo bad)"
if [ "$engine_status" != "running" ]; then
  load_code="$(curl -sS -m 150 -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"model_id":"qwen3-1.7b-abliterated","ttl_hours":720}' \
    -o "$WORK/load.json" -w '%{http_code}' "$BASE/api/engine/load")"
  [ "$load_code" = "200" ] || { cat "$WORK/load.json" >&2; fail "engine load failed ($load_code)"; }
  ok "engine loaded (qwen3-1.7b-abliterated)"
else
  ok "engine already running"
fi

# 6. /api/state and /api/engine/relay must agree on the live port and pid, and
#    the model mapping must be real.
curl -sS -m 5 -H "authorization: Bearer $TOKEN" "$BASE/api/state" -o "$WORK/state.json" || fail "GET /api/state failed"
curl -sS -m 5 -H "authorization: Bearer $TOKEN" "$BASE/api/engine/relay" -o "$WORK/relay.json" || fail "GET /api/engine/relay failed"
node - "$WORK/state.json" "$WORK/relay.json" <<'NODE' || fail "runtime state/relay mismatch"
const fs = require("node:fs");
const [statePath, relayPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const relay = JSON.parse(fs.readFileSync(relayPath, "utf8"));
if (state.engine?.status !== "running") throw new Error(`engine status is ${state.engine?.status}`);
if (!Number.isInteger(state.engine?.port) || state.engine.port <= 0) throw new Error("engine.port is missing");
if (!state.engine?.mmap?.mapped) throw new Error("engine.mmap.mapped is false");
if (relay.active?.port !== state.engine.port) throw new Error(`relay port ${relay.active?.port} != state port ${state.engine.port}`);
if (relay.active?.pid !== state.engine.pid) throw new Error(`relay pid ${relay.active?.pid} != state pid ${state.engine.pid}`);
console.log(`ok: runtime port ${state.engine.port}, pid ${state.engine.pid}, mmap ${state.engine.mmap.perms}`);
NODE
ok "runtime state matches relay and mmap"

# 7. The requested Bengali audio must exist, decode and carry an audio stream.
AUDIO="/home/sahon/Music/mp3/lama/lama-status-2026-11-02.mp3"
[ -s "$AUDIO" ] || fail "audio missing: $AUDIO"
ffmpeg -v error -i "$AUDIO" -f null - >/dev/null 2>&1 || fail "audio does not decode: $AUDIO"
grep -q 'Audio:' <(ffmpeg -hide_banner -i "$AUDIO" 2>&1) || fail "audio has no audio stream: $AUDIO"
duration="$(ffmpeg -hide_banner -i "$AUDIO" 2>&1 | sed -n 's/.*Duration: \([0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9]\).*/\1/p' | head -1)"
[ -n "$duration" ] || fail "audio duration missing"
seconds=$(awk -F: '{ print ($1 * 3600) + ($2 * 60) + $3 }' <<<"$duration")
awk -v s="$seconds" 'BEGIN { exit !(s > 60) }' || fail "audio is only ${duration} (expected >60s)"
ok "audio ${duration}, decodes with an audio stream"

echo "RUNTIME_FIX_OK"
