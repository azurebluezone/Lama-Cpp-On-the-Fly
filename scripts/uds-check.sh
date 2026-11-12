#!/usr/bin/env bash
# uds-check.sh — prove the gateway talks to the engine over UDS and the GGUF is mmap-backed.
#
# Read-only against the running stack: one 2-token request. The only side effect
# is the gateway's own request_logs row. Exit 0 means both claims held now.
# It waits for the gateway and engine because a config change restarts the
# engine, and a check that races the loader would report a false failure.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1

MODE=$(awk -F= '/^LAMA_GATEWAY_ENGINE=/{print $2}' .env | tail -1)
MODEL=/home/sahon/lama/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf
UDS=/tmp/llama-1000/llama.sock

gateway_ready() {
  for _ in $(seq 1 60); do
    curl -fsS --max-time 1 http://127.0.0.1:5252/healthz >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

engine_ready() {
  for _ in $(seq 1 180); do
    curl -fsS --max-time 1 --unix-socket "$UDS" http://localhost/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

engine_pid() {
  local pid
  for pid in $(pgrep -f '^/home/sahon/.local/bin/llama serve .*Qwen2\.5-0\.5B-Instruct-Q4_K_M\.gguf'); do
    grep -q 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf' "/proc/$pid/maps" 2>/dev/null && echo "$pid"
  done | tail -1
}

mapped_state() {
  local pid=$1
  [ -n "$pid" ] || { echo false; return; }
  node -e 'import("./src/engine.ts").then((m)=>{const s=m.mmapStatus(Number(process.argv[1]),process.argv[2]);process.stdout.write(String(s.mapped))})' "$pid" "$MODEL" 2>/dev/null
}

gateway_ready || { echo "engine=${MODE:-unset} mapped=false status=000 upstream=none gateway=down"; exit 1; }
engine_ready || { echo "engine=${MODE:-unset} mapped=false status=000 upstream=none engine=down"; exit 1; }

PID=""
MAPPED=false
for _ in $(seq 1 120); do
  PID=$(engine_pid)
  MAPPED=$(mapped_state "$PID")
  [ "$MAPPED" = "true" ] && break
  sleep 1
done

# One live request through the public gateway. Loopback auth is open.
RESP=$(curl -sS --max-time 60 -D - -o /dev/null \
  -H 'content-type: application/json' \
  -d '{"model":"e2e-qwen","messages":[{"role":"user","content":"Say OK"}],"max_tokens":2,"temperature":0,"stream":false}' \
  http://127.0.0.1:5252/v1/chat/completions 2>/dev/null)
STATUS=$(printf '%s\n' "$RESP" | head -1 | awk '{print $2}')
UPSTREAM=$(printf '%s\n' "$RESP" | tr -d '\r' | grep -i '^x-gateway-upstream:' | head -1 | sed 's/^[^:]*:[[:space:]]*//')

echo "engine=${MODE:-unset} mapped=$MAPPED status=$STATUS upstream=$UPSTREAM"

[ "${MODE:-}" = "uds" ] || exit 1
[ "$MAPPED" = "true" ] || exit 1
[ "$STATUS" = "200" ] || exit 1
[ "$UPSTREAM" = "unix:/tmp/llama-1000/llama.sock" ] || exit 1
exit 0
