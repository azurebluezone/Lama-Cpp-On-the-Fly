#!/usr/bin/env python3
"""Verify the public accountability page and its Bengali audio against frozen evidence.

This is a structural + arithmetic check, not a semantic proof that every prose
sentence is true. It fails loudly when the ledger, the negative-gate record, the
page text, or the audio artifact drift from the snapshot recorded on the page.
"""

from __future__ import annotations

import csv
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "docs/session-accountability.html"
CSV = ROOT / "docs/model-response-ledger.csv"
SUMMARY = ROOT / "docs/model-response-ledger.summary.json"
NEGATIVE = ROOT / "docs/gate-negative-test.json"
AUDIO = ROOT / "docs/audio/session-accountability-live-bn.mp3"
SRT = ROOT / "docs/audio/session-accountability-live-bn.srt"
SCRIPT = ROOT / "docs/audio/session-accountability-live-bn.script.txt"

errors: list[str] = []


def require(ok: bool, message: str) -> None:
    if not ok:
        errors.append(message)


def ffprobe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    require(out.returncode == 0, f"ffprobe failed: {out.stderr.strip()[:200]}")
    try:
        return float(out.stdout.strip())
    except ValueError:
        errors.append(f"ffprobe duration is not numeric: {out.stdout!r}")
        return 0.0


html = HTML.read_text(encoding="utf-8")
require(HTML.stat().st_size > 50_000, f"html too small: {HTML.stat().st_size}")
require('id="model-agent-matrix"' in html, "missing section id=model-agent-matrix")
require("514/514" in html, "missing 514/514 model-attribution statement")
require("570" in html, "missing 570 tool-call count")
require("SELF_AUTHORED_MOCK" in html, "missing controlled negative-test label")
require("deepseek-v4.1-flash-free" in html, "missing model identifier")
require("16.7" in html, "missing unresolved 6/36 percentage")
require("0/36" in html, "missing environment 0/36")
require("F7" in html and "UNRESOLVED" in html, "missing F7 unresolved marker")
require('id="evidence"' in html and "১৫." in html, "evidence section not renumbered to 15")
require(not re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", html), "IPv4 address found in public page")
require("PLACEHOLDER" not in html, "placeholder left in page")

rows: list[dict[str, str]] = []
with CSV.open(newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))
require(len(rows) == 514, f"ledger rows {len(rows)} != 514")
for index, row in enumerate(rows, start=2):
    require(row.get("agent") == "zombiecoder", f"ledger line {index}: agent")
    require(row.get("provider") == "opencode", f"ledger line {index}: provider")
    require(row.get("model") == "deepseek-v4.1-flash-free", f"ledger line {index}: model")
    require(row.get("variant") == "max", f"ledger line {index}: variant")

summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
require(summary.get("assistant_total") == 514, "summary assistant_total != 514")
require(summary.get("assistant_without_model") == 0, "summary has assistant without model")
require(summary.get("tool_calls") == 570, "summary tool_calls != 570")

negative = json.loads(NEGATIVE.read_text(encoding="utf-8"))
require(negative.get("claim_label") == "SELF_AUTHORED_MOCK", "negative test label")
require(negative.get("response_gate", {}).get("passed") is True, "negative response gate did not pass")
require(negative.get("evidence_gate", {}).get("status") == "PASS", "negative evidence gate did not pass")
require(negative.get("actual_project_facts", {}).get("routes_current") == 19, "negative facts routes_current")

require(AUDIO.exists(), f"audio missing: {AUDIO}")
duration = ffprobe_duration(AUDIO) if AUDIO.exists() else 0.0
require(duration > 700, f"audio duration {duration:.3f}s is not above 700s")
size = AUDIO.stat().st_size if AUDIO.exists() else 0
require(size > 4_000_000, f"audio size {size} is too small")

if AUDIO.exists():
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(AUDIO), "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    require(decoded.returncode == 0, f"ffmpeg decode failed: {decoded.stderr.strip()[:300]}")

require(SRT.exists() and SRT.stat().st_size > 10_000, "subtitle file missing or too small")
if SRT.exists():
    cues = re.findall(r"(\d\d:\d\d:\d\d,\d{3}) --> (\d\d:\d\d:\d\d,\d{3})", SRT.read_text(encoding="utf-8"))
    require(len(cues) > 100, f"too few subtitle cues: {len(cues)}")

script_text = SCRIPT.read_text(encoding="utf-8") if SCRIPT.exists() else ""
require("পাঁচশো চৌদ্দ" in script_text, "narration script does not mention the 514-response ledger")
require("পাঁচশো সত্তর" in script_text, "narration script does not mention 570 tool calls")

if errors:
    print("SESSION_ACCOUNTABILITY_DOC_FAIL")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)

EXPECTED_SUMMARY = (
    "The page contains a new section id=model-agent-matrix with 514/514 model-attributed assistant records, "
    "570 tool calls, the controlled negative-gate result, F7 marked unresolved, Environment 0/36 (0%), "
    "Unresolved 6/36 (16.7%), and the evidence section renumbered 15; no IPv4 address appears; the regenerated "
    "MP3 is longer than 700 seconds and decodes with exit 0. The checker prints SESSION_ACCOUNTABILITY_DOC_OK_V2 "
    "with the observed row count and duration."
)
print(EXPECTED_SUMMARY)
print(f"SESSION_ACCOUNTABILITY_DOC_OK_V2 rows={len(rows)} duration={duration:.3f} bytes={size}")
