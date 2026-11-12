#!/usr/bin/env bash
# Local TLS edge: https://localhost:443 -> gateway 127.0.0.1:5252 (API + /admin).
# Caddy runs as this user; no root and no sudo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export LAMA_ROOT="$ROOT"
export LAMA_EDGE_PORT="${LAMA_EDGE_PORT:-9931}"
export LAMA_SITE="${LAMA_SITE:-127.0.0.1}"
CADDYFILE="$ROOT/Caddyfile"
CERT="$ROOT/certs/localhost-cert.pem"

case "${1:-status}" in
  start)
    caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
    # caddy start daemonizes but keeps inherited stdout open, so a caller that
    # pipes this script would wait forever. Give the child its own log file.
    mkdir -p "$ROOT/logs"
    caddy start --config "$CADDYFILE" --adapter caddyfile >"$ROOT/logs/caddy-start.log" 2>&1
    cat "$ROOT/logs/caddy-start.log"
    ;;
  stop)
    caddy stop
    ;;
  run)
    exec caddy run --config "$CADDYFILE" --adapter caddyfile
    ;;
  status)
    code="$(curl -sS --cacert "$CERT" -o /dev/null -w '%{http_code}' "https://127.0.0.1:${LAMA_EDGE_PORT:-9931}/healthz")"
    echo "https://127.0.0.1:${LAMA_EDGE_PORT:-9931}/healthz -> $code"
    [ "$code" = "200" ]
    ;;
  *)
    echo "usage: bash scripts/caddy.sh start|stop|run|status" >&2
    exit 2
    ;;
esac
