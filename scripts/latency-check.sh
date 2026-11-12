#!/usr/bin/env bash
# latency-check.sh — measure one fresh OpenCode session against the live lama gateway.
#
# The real opencode binary runs here. Every printed number is read afterwards from
# the gateway request_logs, the OpenCode session DB and the llama engine log; nothing
# is synthesized. Exit 0 only when a fresh session row names this agent, the gateway
# answered 200 with client_adapter=opencode, the wall clock stayed under the limit,
# and two header probes were labelled differently while producing the same prompt.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1

BASE_URL=${LAMA_GATEWAY_URL:-http://127.0.0.1:5252}
MODEL=${LAMA_MODEL:-e2e-qwen}
AGENT=${LAMA_AGENT:-lama-mini}
STATE=${LAMA_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-lama}
HOMEDIR=$STATE/home
DB=$ROOT/data/manager.db
ENGINE_LOG=$ROOT/logs/engine-$MODEL.log
MODEL_FILE=/home/sahon/lama/models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf
OC_BIN=${OPENCODE_BIN:-$(command -v opencode 2>/dev/null || true)}
PROMPT=${LAMA_PROBE_PROMPT:-"Explain in three short bullet points why a CPU-only llama.cpp server is slow to start answering a long prompt."}
OUT=$STATE/latency-check
WALL_LIMIT_MS=${LAMA_WALL_LIMIT_MS:-30000}

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -n "$OC_BIN" ] || fail "opencode binary not found"
[ -f "$DB" ] || fail "missing $DB"
mkdir -p "$STATE" || fail "cannot create $STATE"
curl -fsS --max-time 5 "$BASE_URL/healthz" >/dev/null 2>&1 || fail "gateway down at $BASE_URL"

max_id() {
  DB="$DB" node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DB,{readOnly:true});process.stdout.write(String(db.prepare("select coalesce(max(id),0) m from request_logs").get().m))'
}

# --- mmap proof (read-only, live process) ---
PID=$(pgrep -f '^/home/sahon/.local/bin/llama serve .*Qwen2\.5-0\.5B-Instruct-Q4_K_M\.gguf' | head -1)
MAP_LINE=""
if [ -n "$PID" ]; then
  MAP_LINE=$(awk -v f="$MODEL_FILE" '$6==f && $2=="r--s" {print $1" "$2" "$6; exit}' "/proc/$PID/maps" 2>/dev/null)
fi
[ -n "$MAP_LINE" ] && MAP_STATE=mmap || MAP_STATE=unmapped

# --- one fresh OpenCode session, real binary ---
SID="ses_lat_$(date +%s)_$RANDOM"
BEFORE=$(max_id) || fail "cannot read request_logs"
ENGINE_OFF=0
[ -f "$ENGINE_LOG" ] && ENGINE_OFF=$(wc -c <"$ENGINE_LOG")
T0=$(date +%s%3N)
LAMA_SESSION_ID="$SID" LAMA_RUN_TIMEOUT=60 LAMA_AGENT="$AGENT" LAMA_MODEL="$MODEL" \
  "$ROOT/scripts/opencode-lama-session.sh" --check --prompt "$PROMPT" >"$OUT.launcher" 2>&1
RC=$?
T1=$(date +%s%3N)
WALL_MS=$((T1 - T0))

NODE_OUT=$(DB="$DB" HOMEDIR="$HOMEDIR" SID="$SID" BEFORE="$BEFORE" AGENT="$AGENT" node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");

const db = new DatabaseSync(process.env.DB, { readOnly: true });
const row = db.prepare(
  "select id,status,duration_ms,first_token_ms,prompt_tokens,completion_tokens,bytes,client_adapter,stream,transport_id from request_logs where id > ? order by id desc limit 1"
).get(Number(process.env.BEFORE));

const file = process.env.HOMEDIR + "/.local/share/opencode/opencode.db";
let sess = null;
if (fs.existsSync(file)) {
  const sdb = new DatabaseSync(file, { readOnly: true });
  try { sess = sdb.prepare("select id,agent,model from session_v2 where id=?").get(process.env.SID); } catch {}
}

const status = row ? String(row.status) : "0";
const adapter = row ? String(row.client_adapter || "none") : "none";
const stream = row ? String(row.stream ?? 0) : "0";
const sessionOk = Boolean(
  sess &&
  sess.agent === process.env.AGENT &&
  String(sess.model || "").includes('"providerID":"lama"') &&
  status === "200" &&
  adapter === "opencode" &&
  stream === "1"
);

const out = {
  session_ok: sessionOk ? "1" : "0",
  session_row: sess ? "1" : "0",
  status,
  adapter,
  stream,
  gid: row ? String(row.id) : "0",
  duration_ms: row && row.duration_ms != null ? String(row.duration_ms) : "null",
  first_token_ms: row && row.first_token_ms != null ? String(row.first_token_ms) : "null",
  prompt_tokens: row && row.prompt_tokens != null ? String(row.prompt_tokens) : "null",
  completion_tokens: row && row.completion_tokens != null ? String(row.completion_tokens) : "null",
  bytes: row && row.bytes != null ? String(row.bytes) : "null",
  transport_id: row ? String(row.transport_id || "none") : "none",
};
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
NODE
)

S_OK=0; S_ROW=0; STATUS=0; ADAPTER=none; STREAM=0; GID=0
DURATION=null; FIRST=null; PTOK=null; CTOK=null; BYTES=null; TID=none
while IFS='=' read -r k v; do
  case "$k" in
    session_ok) S_OK=$v ;;
    session_row) S_ROW=$v ;;
    status) STATUS=$v ;;
    adapter) ADAPTER=$v ;;
    stream) STREAM=$v ;;
    gid) GID=$v ;;
    duration_ms) DURATION=$v ;;
    first_token_ms) FIRST=$v ;;
    prompt_tokens) PTOK=$v ;;
    completion_tokens) CTOK=$v ;;
    bytes) BYTES=$v ;;
    transport_id) TID=$v ;;
  esac
done <<<"$NODE_OUT"

# --- engine log lines produced by this run ---
ENGINE_LINES=""
if [ -f "$ENGINE_LOG" ]; then
  ENGINE_LINES=$(tail -c +$((ENGINE_OFF + 1)) "$ENGINE_LOG" 2>/dev/null | grep 'print_timing' | tail -8)
fi

# --- header probe: same body, two different labels, same prompt ---
PROBE_BODY='{"model":"e2e-qwen","messages":[{"role":"user","content":"Reply with exactly: PONG"}],"max_tokens":8,"temperature":0,"stream":false}'
probe() {
  local label=$1 before=$2 prefix=$3
  curl -sS --max-time 30 -D "$prefix.h" -o "$prefix.json" \
    -H 'content-type: application/json' -H "x-lama-client: $label" \
    -d "$PROBE_BODY" "$BASE_URL/v1/chat/completions" || return 1
  local code
  code=$(head -1 "$prefix.h" | awk '{print $2}')
  DB="$DB" BEFORE="$before" LABEL="$label" CODE="$code" PREFIX="$prefix" node <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const db = new DatabaseSync(process.env.DB, { readOnly: true });
const row = db.prepare(
  "select id,status,client_adapter from request_logs where id > ? order by id desc limit 1"
).get(Number(process.env.BEFORE));
const j = JSON.parse(fs.readFileSync(process.env.PREFIX + ".json", "utf8"));
const reply = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
const pt = j.usage && j.usage.prompt_tokens != null ? String(j.usage.prompt_tokens) : "null";
console.log(`id=${row ? row.id : 0}`);
console.log(`status=${row ? row.status : process.env.CODE}`);
console.log(`adapter=${row ? (row.client_adapter || "none") : "none"}`);
console.log(`prompt_tokens=${pt}`);
console.log(`reply=${JSON.stringify(reply)}`);
NODE
}

PA=$(max_id); probe "zc-probe-short" "$PA" "$OUT.probe-a" >"$OUT.probe-a.txt" 2>&1
PB=$(max_id); probe "zc-probe-a-considerably-longer-label-1234567890" "$PB" "$OUT.probe-b" >"$OUT.probe-b.txt" 2>&1

# Extract probe fields with a tiny reader so values survive spaces.
field() {
  awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/,""); print; exit}' "$2"
}
PA_ID=$(field id "$OUT.probe-a.txt"); PA_STATUS=$(field status "$OUT.probe-a.txt")
PA_ADAPTER=$(field adapter "$OUT.probe-a.txt"); PA_PT=$(field prompt_tokens "$OUT.probe-a.txt")
PA_REPLY=$(field reply "$OUT.probe-a.txt")
PB_ID=$(field id "$OUT.probe-b.txt"); PB_STATUS=$(field status "$OUT.probe-b.txt")
PB_ADAPTER=$(field adapter "$OUT.probe-b.txt"); PB_PT=$(field prompt_tokens "$OUT.probe-b.txt")
PB_REPLY=$(field reply "$OUT.probe-b.txt")

LABEL_ONLY=0
[ "$PA_ADAPTER" = "zc-probe-short" ] && [ "$PB_ADAPTER" = "zc-probe-a-considerably-longer-label-1234567890" ] \
  && [ "$PA_PT" != "null" ] && [ "$PA_PT" = "$PB_PT" ] && [ "$PA_REPLY" = "$PB_REPLY" ] && LABEL_ONLY=1

# --- report ---
echo "mapping=$MAP_STATE pid=${PID:-none} range=${MAP_LINE:-none}"
echo "launcher_rc=$RC session_id=$SID agent=$AGENT model=lama/$MODEL"
echo "session_row=$S_ROW"
echo "gateway_row=id:$GID status:$STATUS transport:$TID stream:$STREAM adapter:$ADAPTER duration_ms:$DURATION first_token_ms:$FIRST prompt_tokens:$PTOK completion_tokens:$CTOK bytes:$BYTES"
echo "wall_ms=$WALL_MS limit_ms=$WALL_LIMIT_MS"
if [ -n "$ENGINE_LINES" ]; then
  echo "engine_timing:"
  printf '%s\n' "$ENGINE_LINES" | sed 's/^/  /'
else
  echo "engine_timing: none"
fi
echo "probe_a=id:$PA_ID status:$PA_STATUS adapter:$PA_ADAPTER prompt_tokens:$PA_PT reply:$PA_REPLY"
echo "probe_b=id:$PB_ID status:$PB_STATUS adapter:$PB_ADAPTER prompt_tokens:$PB_PT reply:$PB_REPLY"
echo "header_label_only=$LABEL_ONLY"
echo "session_ok=$S_OK status=$STATUS adapter=$ADAPTER"

[ "$S_OK" = "1" ] && [ "$STATUS" = "200" ] && [ "$ADAPTER" = "opencode" ] \
  && [ "$WALL_MS" -lt "$WALL_LIMIT_MS" ] && [ "$LABEL_ONLY" = "1" ] || exit 1
exit 0
