#!/usr/bin/env python3
"""Verify the plugin-scope / real-life-roles section and its Bengali audio.

The check is structural: it proves the section, citations, audio, subtitles and
delivery copy exist and match. It does not turn prose into truth.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "docs/session-accountability.html"
AUDIO = ROOT / "docs/audio/one-writer-correction-bn.mp3"
SRT = ROOT / "docs/audio/one-writer-correction-bn.srt"
SCRIPT = ROOT / "docs/audio/one-writer-correction-bn.script.txt"
DELIVERY = Path("/home/sahon/Music/work mp3/accountability")

errors: list[str] = []


def require(ok: bool, message: str) -> None:
    if not ok:
        errors.append(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


html = HTML.read_text(encoding="utf-8") if HTML.exists() else ""
require(HTML.exists() and HTML.stat().st_size > 60_000, f"html missing or too small: {HTML}")
require('id="plugin-scope-and-roles"' in html, "missing section id=plugin-scope-and-roles")
for phrase in (
    "OpenCode V2",
    "Hooks intercept live operations",
    "Native HTTP",
    "http.response",
    "system prompt",
    "operator/company",
    "UNVERIFIED",
    "আড়াল",
    "assurance gap",
    "plugin.ts:1587",
    "plugin.ts:1605",
    "responseGate.ts:740",
    "plugin.ts:1720",
):
    require(phrase in html, f"page missing phrase: {phrase}")
require("https://opencode.ai/v2/docs/build/plugins/server" in html, "missing official plugin doc URL")
require("https://opencode.ai/v2/docs/agents" in html, "missing official agents doc URL")
require("PLACEHOLDER" not in html, "placeholder left in page")
require(not re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", html), "IPv4 address found in public page")

require(AUDIO.exists(), f"audio missing: {AUDIO}")
duration = ffprobe_duration(AUDIO) if AUDIO.exists() else 0.0
require(600 <= duration <= 2400, f"audio duration {duration:.3f}s outside 600..2400s")
size = AUDIO.stat().st_size if AUDIO.exists() else 0
require(size > 2_000_000, f"audio size {size} is too small")

if AUDIO.exists():
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(AUDIO), "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=240,
    )
    require(decoded.returncode == 0, f"ffmpeg decode failed: {decoded.stderr.strip()[:300]}")

cues: list[tuple[str, str]] = []
if SRT.exists():
    cues = re.findall(r"(\d\d:\d\d:\d\d,\d{3}) --> (\d\d:\d\d:\d\d,\d{3})", SRT.read_text(encoding="utf-8"))
require(SRT.exists() and SRT.stat().st_size > 8_000, "subtitle file missing or too small")
require(len(cues) >= 100, f"too few subtitle cues: {len(cues)}")

script_text = SCRIPT.read_text(encoding="utf-8") if SCRIPT.exists() else ""
for phrase in ("ওপেন কোড", "http.response", "hooks intercept", "সিস্টেম প্রম্পট", "UNVERIFIED", "আড়াল", "operator", "প্লাগইন"):
    require(phrase in script_text, f"script missing phrase: {phrase}")

require(AUDIO.name in html, f"page does not reference {AUDIO.name}")
if duration:
    require(f"{duration:.3f}" in html, f"page does not contain audio duration {duration:.3f}")

delivery_ok = True
for source in (AUDIO, SRT, SCRIPT):
    target = DELIVERY / source.name
    if not source.exists() or not target.exists():
        delivery_ok = False
        errors.append(f"delivery copy missing: {target}")
        continue
    if sha256(source) != sha256(target):
        delivery_ok = False
        errors.append(f"delivery copy differs: {target}")
require(delivery_ok, "delivery copy is not byte-identical")

if errors:
    print("PLUGIN_SCOPE_FAIL")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)

print("PASS: plugin-scope section, official citations, audio, SRT and delivery copy match; no IPv4 in the page.")
print(f"PLUGIN_SCOPE_OK html=1 audio=1 srt=1 deliver=1 ipv4=0 duration={duration:.3f} cues={len(cues)}")
