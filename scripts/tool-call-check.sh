#!/usr/bin/env bash
# tool-call-check.sh — prove the engine really answers a tool call over every
# surface this manager documents: Anthropic /v1/messages, OpenAI
# /v1/chat/completions over TCP, and the same OpenAI call over the unix socket.
#
# The model is loaded through the admin URL (POST /api/engine/load) — the same
# call the UI makes — so the check never assumes a preloaded engine.
#
# Usage: bash scripts/tool-call-check.sh [model-id-or-alias]
# Output: one line `tool_calls=N/3`; exit 0 only when N=3.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

ADMIN="${LAMA_ADMIN_URL:-http://127.0.0.1:9933}"
ENGINE="${LAMA_ENGINE_URL:-http://127.0.0.1:9932}"
SOCK="${LAMA_UDS_SOCK:-/tmp/llama-1000/llama.sock}"
MODEL="${1:-qwen2.5-0.5b}"
WORK="$(mktemp -d /tmp/opencode/tool-call.XXXXXX)" || exit 2
EVIDENCE="$ROOT/data/tool-call-evidence.json"

TOKEN="$(sed -n 's/^LAMA_ADMIN_TOKEN=//p' "$ROOT/.env" | head -1)"
if [ -z "$TOKEN" ]; then
  echo "no LAMA_ADMIN_TOKEN in .env" >&2
  exit 2
fi

if ! command -v jq >/dev/null; then
  echo "jq is required" >&2
  exit 2
fi

# 1) Load the model through the admin URL, exactly like the Model List does.
load_code="$(curl -sS -m 200 -o "$WORK/load.json" -w '%{http_code}' \
  -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"model_id\":\"$MODEL\",\"ttl_hours\":1}" "$ADMIN/api/engine/load")"
load_status="$(jq -r '.status // "unknown"' "$WORK/load.json" 2>/dev/null)"
echo "load: HTTP $load_code status=$load_status pid=$(jq -r '.pid // "-"' "$WORK/load.json" 2>/dev/null)" >&2
if [ "$load_code" != "200" ] || [ "$load_status" != "running" ]; then
  jq -r '.error // .last_error // empty' "$WORK/load.json" >&2
  echo "tool_calls=0/3"
  exit 1
fi

OPENAI_BODY="$(jq -nc --arg m "$MODEL" '{
  model: $m, max_tokens: 128, temperature: 0, tool_choice: "auto",
  messages: [{role: "user", content: "What is 17+25? Use the add tool."}],
  tools: [{type: "function", function: {
    name: "add", description: "Add two integers",
    parameters: {type: "object", properties: {a: {type: "integer"}, b: {type: "integer"}}, required: ["a", "b"]}
  }}]
}')"
ANTHROPIC_BODY="$(jq -nc --arg m "$MODEL" '{
  model: $m, max_tokens: 128, temperature: 0,
  messages: [{role: "user", content: "What is 17+25? Use the add tool."}],
  tools: [{name: "add", description: "Add two integers",
    input_schema: {type: "object", properties: {a: {type: "integer"}, b: {type: "integer"}}, required: ["a", "b"]}}]
}')"

# 2) Anthropic Messages over TCP.
an_code="$(curl -sS -m 180 -o "$WORK/anthropic.json" -w '%{http_code}' \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d "$ANTHROPIC_BODY" "$ENGINE/v1/messages")"
an_name="$(jq -r '[.content[]? | select(.type=="tool_use") | .name] | join(",")' "$WORK/anthropic.json" 2>/dev/null)"
an_input="$(jq -c '[.content[]? | select(.type=="tool_use") | .input] | first // null' "$WORK/anthropic.json" 2>/dev/null)"
an_stop="$(jq -r '.stop_reason // "-"' "$WORK/anthropic.json" 2>/dev/null)"
echo "anthropic: HTTP $an_code stop_reason=$an_stop tool=$an_name input=$an_input" >&2

# 3) OpenAI chat completions over TCP.
oa_code="$(curl -sS -m 180 -o "$WORK/openai.json" -w '%{http_code}' \
  -H 'content-type: application/json' -d "$OPENAI_BODY" "$ENGINE/v1/chat/completions")"
oa_name="$(jq -r '[.choices[0].message.tool_calls[]?.function.name] | join(",")' "$WORK/openai.json" 2>/dev/null)"
oa_args="$(jq -r '.choices[0].message.tool_calls[0].function.arguments // "-"' "$WORK/openai.json" 2>/dev/null)"
echo "openai:    HTTP $oa_code finish=$(jq -r '.choices[0].finish_reason // "-"' "$WORK/openai.json" 2>/dev/null) tool=$oa_name args=$oa_args" >&2

# 4) Same OpenAI body over the unix socket.
uds_code="$(curl -sS -m 180 --unix-socket "$SOCK" -o "$WORK/uds.json" -w '%{http_code}' \
  -H 'content-type: application/json' -d "$OPENAI_BODY" "http://localhost/v1/chat/completions")"
uds_name="$(jq -r '[.choices[0].message.tool_calls[]?.function.name] | join(",")' "$WORK/uds.json" 2>/dev/null)"
uds_args="$(jq -r '.choices[0].message.tool_calls[0].function.arguments // "-"' "$WORK/uds.json" 2>/dev/null)"
echo "uds:       HTTP $uds_code finish=$(jq -r '.choices[0].finish_reason // "-"' "$WORK/uds.json" 2>/dev/null) tool=$uds_name args=$uds_args" >&2

count=0
[ "$an_code" = "200" ] && [ "$an_name" = "add" ] && [ "$an_stop" = "tool_use" ] && count=$((count + 1))
[ "$oa_code" = "200" ] && [ "$oa_name" = "add" ] && count=$((count + 1))
[ "$uds_code" = "200" ] && [ "$uds_name" = "add" ] && count=$((count + 1))

mkdir -p "$(dirname "$EVIDENCE")"
jq -n \
  --arg at "$(date -Iseconds)" --arg model "$MODEL" \
  --argjson load "$(jq -c '{status, model_id, pid, port, socket_path}' "$WORK/load.json")" \
  --argjson anthropic "$(jq -c '{http: "'"$an_code"'", stop_reason, tool_use: [.content[]? | select(.type=="tool_use") | {name, input}]}' "$WORK/anthropic.json" 2>/dev/null || echo '{}')" \
  --argjson openai "$(jq -c '{http: "'"$oa_code"'", finish_reason: .choices[0].finish_reason, tool_calls: [.choices[0].message.tool_calls[]? | {name: .function.name, arguments: .function.arguments}]}' "$WORK/openai.json" 2>/dev/null || echo '{}')" \
  --argjson uds "$(jq -c '{http: "'"$uds_code"'", finish_reason: .choices[0].finish_reason, tool_calls: [.choices[0].message.tool_calls[]? | {name: .function.name, arguments: .function.arguments}]}' "$WORK/uds.json" 2>/dev/null || echo '{}')" \
  --argjson result "$count" \
  '{generated_at: $at, model: $model, load: $load, anthropic: $anthropic, openai_tcp: $openai, openai_uds: $uds, tool_calls: $result}' \
  > "$EVIDENCE"

echo "evidence: $EVIDENCE" >&2
echo "tool_calls=$count/3"
[ "$count" -eq 3 ]
