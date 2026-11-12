#!/usr/bin/env python3
"""Verify the one-writer correction panel, its Bengali audio and the delivery copy.

The check is deliberately structural: it proves the page, audio, subtitles and
delivery copy exist and match each other. It does not prove that every prose
sentence on the page is true; the prose evidence is cited separately.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "docs/session-accountability.html"
DOCS_MD = ROOT / "docs/lam cpp.md"
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
require(HTML.exists() and HTML.stat().st_size > 50_000, f"html missing or too small: {HTML}")
require('id="one-writer-correction"' in html, "missing section id=one-writer-correction")
require("একজন লেখক" in html, "missing one-writer statement")
require("একটি ফ্রেম" in html, "missing one-frame statement")
require("docs/lam cpp.md" in html, "missing docs/lam cpp.md citation")
require("৪৩" in html, "missing 43-line docs evidence")
require("line 25" in html, "missing docs line 25 evidence")
require("১২টি" in html, "missing 12-item docs sidebar evidence")
require("UNVERIFIED" in html, "missing UNVERIFIED training-data label")
require("PLACEHOLDER" not in html, "placeholder left in page")
require(not re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", html), "IPv4 address found in public page")

docs_text = DOCS_MD.read_text(encoding="utf-8") if DOCS_MD.exists() else ""
require(DOCS_MD.exists(), f"missing docs source: {DOCS_MD}")
require(len(docs_text.splitlines()) == 43, f"docs line count changed: {len(docs_text.splitlines())} != 43")
require("মডেল প্রোভাইডার" in docs_text, "docs no longer contains the sidebar list")
require("সাইডবারে আইটেম হিসেবে" in docs_text, "docs no longer contains the sidebar sentence")

require(AUDIO.exists(), f"audio missing: {AUDIO}")
duration = ffprobe_duration(AUDIO) if AUDIO.exists() else 0.0
require(600 <= duration <= 1800, f"audio duration {duration:.3f}s outside 600..1800s")
size = AUDIO.stat().st_size if AUDIO.exists() else 0
require(size > 2_000_000, f"audio size {size} is too small")

if AUDIO.exists():
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(AUDIO), "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=180,
    )
    require(decoded.returncode == 0, f"ffmpeg decode failed: {decoded.stderr.strip()[:300]}")

cues: list[tuple[str, str]] = []
if SRT.exists():
    cues = re.findall(r"(\d\d:\d\d:\d\d,\d{3}) --> (\d\d:\d\d:\d\d,\d{3})", SRT.read_text(encoding="utf-8"))
require(SRT.exists() and SRT.stat().st_size > 8_000, "subtitle file missing or too small")
require(len(cues) >= 80, f"too few subtitle cues: {len(cues)}")

script_text = SCRIPT.read_text(encoding="utf-8") if SCRIPT.exists() else ""
for phrase in ("একজন লেখক", "একটি ফ্রেম", "docs/lam cpp.md", "তেতাল্লিশ", "লাইন পঁচিশে", "UNVERIFIED", "পাঁচশো চৌদ্দ"):
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
    print("ONE_WRITER_AUDIO_FAIL")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)

print("PASS: one-writer panel, audio, SRT and delivery copy match; no IPv4 in the page.")
print(f"ONE_WRITER_AUDIO_OK html=1 audio=1 srt=1 deliver=1 ipv4=0 duration={duration:.3f} cues={len(cues)}")
