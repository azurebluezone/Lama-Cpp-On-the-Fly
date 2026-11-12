#!/usr/bin/env bash
# audio-check.sh — verify the narration MP3 the user asked for.
# Usage: scripts/audio-check.sh <file.mp3>

set -uo pipefail

FILE=${1:-}
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "audio_ok=0 reason=missing file=${FILE:-none}"
  exit 1
fi

CODEC=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$FILE" 2>/dev/null | head -1)
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE" 2>/dev/null | head -1)
DUR_INT=${DURATION%.*}
SIZE=$(stat -c %s "$FILE" 2>/dev/null || echo 0)
TYPE=$(file -b --mime-type "$FILE" 2>/dev/null || echo unknown)

echo "audio_ok=1 codec=$CODEC duration_s=${DUR_INT:-0} size_bytes=$SIZE mime=$TYPE"

[ "$CODEC" = "mp3" ] || exit 1
[ "${DUR_INT:-0}" -ge 180 ] || exit 1
[ "$SIZE" -gt 100000 ] || exit 1
exit 0
