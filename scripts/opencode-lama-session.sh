#!/usr/bin/env bash
# opencode-lama-session.sh — open a fresh OpenCode session on the local lama gateway.
#
# Why this file exists: an OpenCode session stores its model, so editing
# opencode.json cannot move an already-open session off a broken provider.
# This launcher creates a NEW session with lama/e2e-qwen and the zero-tool
# lama-mini agent. It uses an isolated OpenCode home and a work directory
# outside $HOME on purpose: ancestor .opencode/plugins and global MCP servers
# add ~13K prompt tokens, and a 0.5B CPU model cannot prefill that in a usable
# time. The agent is copied from .opencode/agents/lama-mini.md, so the project
# file stays the single source.
#
# Usage:
#   scripts/opencode-lama-session.sh                 create a session, open the TUI
#   scripts/opencode-lama-session.sh --no-open       create the session, print its id
#   scripts/opencode-lama-session.sh --session ID    open an existing session
#   scripts/opencode-lama-session.sh --check         non-interactive proof, exit 0 on pass
#   scripts/opencode-lama-session.sh --prompt TEXT   bootstrap message (default: OK probe)
#
# Env overrides: LAMA_GATEWAY_URL, LAMA_MODEL, LAMA_AGENT, LAMA_STATE_DIR,
#                LAMA_WORK_DIR, OPENCODE_BIN

set -uo pipefail

ROOT=${LAMA_AGENT_ROOT:-/home/sahon/zclama}
BASE_URL=${LAMA_GATEWAY_URL:-http://127.0.0.1:5252}
MODEL=${LAMA_MODEL:-e2e-qwen}
AGENT=${LAMA_AGENT:-lama-mini}
STATE=${LAMA_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-lama}
HOMEDIR=$STATE/home
WORKDIR=${LAMA_WORK_DIR:-/tmp/opencode/lama-session/work}
LOGFILE=$HOMEDIR/.local/share/opencode/log/opencode.log
AGENT_FILE=$ROOT/.opencode/agents/$AGENT.md
OC_BIN=${OPENCODE_BIN:-$(command -v opencode 2>/dev/null || true)}

MODE=open
SID=""
PROMPT="Reply with exactly: OK"

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --no-open) MODE=no-open ;;
    --session) SID=${2:-}; shift ;;
    --prompt) PROMPT=${2:-}; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$OC_BIN" ]; then
  echo "opencode binary not found (set OPENCODE_BIN)" >&2
  exit 1
fi

prepare_home() {
  mkdir -p "$HOMEDIR/.config/opencode/agents" "$HOMEDIR/.local/share" "$HOMEDIR/.cache" "$WORKDIR" || return 1
  [ -f "$AGENT_FILE" ] || return 1
  cp "$AGENT_FILE" "$HOMEDIR/.config/opencode/agents/$AGENT.md" || return 1
  node -e '
const fs = require("fs");
const [src, dst, agent, model] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(src, "utf8"));
cfg.model = "lama/" + model;
cfg.default_agent = agent;
fs.writeFileSync(dst, JSON.stringify(cfg, null, 2) + "\n");
' "$ROOT/opencode.json" "$HOMEDIR/.config/opencode/opencode.json" "$AGENT" "$MODEL"
}

gateway_up() {
  curl -fsS --max-time 5 "$BASE_URL/healthz" >/dev/null 2>&1 || return 1
  curl -fsS --max-time 5 "$BASE_URL/v1/models" 2>/dev/null | grep -q "\"$MODEL\"" || return 1
  return 0
}

agent_ready() {
  [ -f "$AGENT_FILE" ] && grep -q "model: lama/$MODEL" "$AGENT_FILE" && [ -f "$HOMEDIR/.config/opencode/agents/$AGENT.md" ]
}

new_sid() {
  printf 'ses_lama_%s_%s' "$(date +%s)" "$RANDOM"
}

run_session() {
  local sid="$1" rc
  cd "$WORKDIR" || return 1
  env HOME="$HOMEDIR" \
      XDG_CONFIG_HOME="$HOMEDIR/.config" \
      XDG_DATA_HOME="$HOMEDIR/.local/share" \
      XDG_CACHE_HOME="$HOMEDIR/.cache" \
      timeout "${LAMA_RUN_TIMEOUT:-100}" "$OC_BIN" run --standalone --session "$sid" \
        --agent "$AGENT" -m "lama/$MODEL" \
        --title "lama session" "$PROMPT" >"$STATE/last-run.out" 2>&1
  rc=$?
  printf '%s' "$rc"
}

gateway_max_id() {
  node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/home/sahon/zclama/data/manager.db",{readOnly:true});process.stdout.write(String(db.prepare("select coalesce(max(id),0) m from request_logs").get().m))'
}

fresh_ok() {
  local before="$1"
  node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("/home/sahon/zclama/data/manager.db",{readOnly:true});
const row=db.prepare("select id,status,bytes from request_logs where id > ? and status=200 and client_adapter=? and stream=1 order by id desc limit 1").get(Number(process.argv[1]),"opencode");
if(row) process.stdout.write("fresh=1 status=200 adapter=opencode bytes="+row.bytes);
else process.stdout.write("fresh=0 status=0 adapter=none");
' "$before"
}

# Exit 0 when the session row names this agent and the lama provider.
session_ok() {
  local sid="$1"
  node -e '
const {DatabaseSync}=require("node:sqlite");
const fs=require("fs");
const file=process.argv[1], sid=process.argv[2], agent=process.argv[3];
if(!fs.existsSync(file)) process.exit(1);
const db=new DatabaseSync(file,{readOnly:true});
const row=db.prepare("select id,agent,model from session_v2 where id=?").get(sid);
process.exit(row && row.agent===agent && String(row.model).includes("\"providerID\":\"lama\"") ? 0 : 1);
' "$HOMEDIR/.local/share/opencode/opencode.db" "$sid" "$AGENT"
}

stream_errors() {
  local start="$1"
  [ -f "$LOGFILE" ] || { printf '0'; return; }
  awk -v t="timestamp=$start" '$0 ~ /Invalid .* stream event/ && $1 >= t {n++} END {print n+0}' "$LOGFILE"
}

prepare_home || { echo "cannot prepare $HOMEDIR (agent: $AGENT_FILE)" >&2; exit 1; }

if [ "$MODE" = "check" ]; then
  A=0; agent_ready && A=1
  G=down; gateway_up && G=up
  SID=${LAMA_SESSION_ID:-$(new_sid)}
  BEFORE=$(gateway_max_id)
  START=$(date -u +%FT%TZ)
  RC=$(run_session "$SID")
  S=0; session_ok "$SID" && S=1
  FRESH=$(fresh_ok "$BEFORE")
  ERR=$(stream_errors "$START")
  printf 'agent=%s gateway=%s session=%s rc=%s %s\n' "$A" "$G" "$S" "$RC" "$FRESH"
  printf 'session_id=%s stream_errors=%s log=%s\n' "$SID" "$ERR" "$LOGFILE"
  [ "$A" = "1" ] && [ "$G" = "up" ] && [ "$S" = "1" ] && [ "$RC" = "0" ] && [ "$ERR" = "0" ] && [[ "$FRESH" == fresh=1* ]] || exit 1
  exit 0
fi

agent_ready || { echo "agent missing: $AGENT_FILE" >&2; exit 1; }
gateway_up || { echo "gateway=down at $BASE_URL (systemctl --user start lama-gateway)" >&2; exit 1; }
[ -n "$SID" ] || SID=$(new_sid)

if ! session_ok "$SID"; then
  RC=$(run_session "$SID")
  if [ "$RC" != "0" ]; then
    echo "bootstrap failed rc=$RC; see $STATE/last-run.out" >&2
    sed -n '1,20p' "$STATE/last-run.out" >&2 2>/dev/null || true
    exit 1
  fi
fi

echo "session=$SID"
echo "model=lama/$MODEL agent=$AGENT state=$HOMEDIR work=$WORKDIR"
echo "open later: $0 --session $SID"

if [ "$MODE" = "no-open" ] || [ ! -t 0 ] || [ ! -t 1 ]; then
  exit 0
fi

cd "$WORKDIR" || exit 1
exec env HOME="$HOMEDIR" \
  XDG_CONFIG_HOME="$HOMEDIR/.config" \
  XDG_DATA_HOME="$HOMEDIR/.local/share" \
  XDG_CACHE_HOME="$HOMEDIR/.cache" \
  "$OC_BIN" --standalone --session "$SID"
