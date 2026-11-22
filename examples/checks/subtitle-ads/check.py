#!/usr/bin/env python3
"""
PlexFixer check script: find advert and credit cues in text subtitles.

Protocol 1. The job arrives as one JSON document on stdin; the answer is one
{"type":"result","findings":[...]} line on stdout. Standard library only.
"""

import json
import re
import subprocess
import sys

TIMING = re.compile(r"^\d+:\d\d:\d\d[,.]\d+\s+-->\s")


def cues(srt):
    """The text of each cue, joined onto one line."""
    for block in re.split(r"\r?\n\s*\r?\n", srt.strip()):
        lines = block.splitlines()
        at = next((i for i, line in enumerate(lines) if TIMING.match(line.strip())), None)
        if at is not None:
            yield " ".join(line.strip() for line in lines[at + 1 :])


def main():
    job = json.load(sys.stdin)
    params = job["params"]
    patterns = [re.compile(p, re.IGNORECASE) for p in params.get("patterns", [])]
    codecs = set(params.get("codecs", ["subrip", "mov_text"]))
    tracks = [
        s for s in job["file"]["streams"]
        if s.get("kind") == "subtitle" and str(s.get("codec", "")).lower() in codecs
    ]

    findings = []
    for track in tracks:
        index = track["index"]
        done = subprocess.run(
            [job["ffmpegPath"], "-v", "error", "-i", job["input"], "-map", f"0:{index}", "-f", "srt", "-"],
            capture_output=True,
            text=True,
            errors="replace",
        )
        if done.returncode != 0:
            print(json.dumps({"type": "log", "level": "warn", "text": f"Could not read track {index}"}), flush=True)
            continue
        hits = [text for text in cues(done.stdout) if any(p.search(text) for p in patterns)]
        if hits:
            language = track.get("language") or "und"
            findings.append({
                "code": "adverts",
                "title": f"{len(hits)} advert line{'s' if len(hits) != 1 else ''} in subtitle track {index} ({language})",
                "detail": "For example: " + " · ".join(hits[:3]),
                "streamIndexes": [index],
            })

    print(json.dumps({"type": "result", "findings": findings}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - shown as the reason the check failed
        print(str(error), file=sys.stderr)
        sys.exit(1)
