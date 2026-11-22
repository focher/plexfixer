#!/usr/bin/env python3
"""
PlexFixer repair script: remove advert and credit cues from text subtitles.

Protocol 1. The job arrives as one JSON document on stdin; progress, log
lines and exactly one result go to stdout, one JSON object per line. The
repaired file is written to `output`. Standard library only.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

TAG = "plexfixer_scrubbed"


def say(**event):
    print(json.dumps(event), flush=True)


def run(command):
    done = subprocess.run(command, capture_output=True, text=True)
    if done.returncode != 0:
        shown = " ".join(command[1:])
        raise RuntimeError(f"{os.path.basename(command[0])} failed: {shown}\n{done.stderr[-4000:]}")
    return done.stdout


def probe(ffprobe, path):
    return json.loads(run([ffprobe, "-v", "error", "-show_streams", "-of", "json", path])).get("streams", [])


TIMING = re.compile(r"^\d+:\d\d:\d\d[,.]\d+\s+-->\s+\d+:\d\d:\d\d[,.]\d+")


def scrub_srt(text, patterns):
    """Drop every cue whose text matches a pattern; renumber the rest."""
    blocks = [block for block in re.split(r"\r?\n\s*\r?\n", text.strip()) if block.strip()]
    kept, removed = [], []
    for block in blocks:
        lines = block.splitlines()
        # A cue is an optional number, a timing line, then its text.
        at = next((i for i, line in enumerate(lines) if TIMING.match(line.strip())), None)
        if at is None:
            continue
        timing, body = lines[at].strip(), lines[at + 1 :]
        spoken = " ".join(body)
        if any(pattern.search(spoken) for pattern in patterns):
            removed.append(spoken.strip())
        else:
            kept.append((timing, body))
    cleaned = "\n\n".join(f"{n}\n{timing}\n" + "\n".join(body) for n, (timing, body) in enumerate(kept, 1))
    return cleaned + "\n", removed


def main():
    job = json.load(sys.stdin)
    params = job["params"]
    patterns = [re.compile(p, re.IGNORECASE) for p in params.get("patterns", [])]
    codecs = set(params.get("codecs", ["subrip", "mov_text"]))
    source, output = job["input"], job["output"]
    ffmpeg, ffprobe = job["ffmpegPath"], job["ffprobePath"]

    streams = probe(ffprobe, source)
    targets = [s for s in streams if s.get("codec_type") == "subtitle" and s.get("codec_name") in codecs]
    is_mp4 = output.lower().endswith((".mp4", ".m4v"))

    with tempfile.TemporaryDirectory(prefix="plexfixer-scrub-") as scratch:
        cleaned = {}
        total_removed = 0
        for n, stream in enumerate(targets):
            index = stream["index"]
            say(type="progress", fraction=n / max(1, len(targets)), message=f"Cleaning subtitle track {index}")
            raw = os.path.join(scratch, f"track-{index}.srt")
            run([ffmpeg, "-v", "error", "-i", source, "-map", f"0:{index}", "-c:s", "srt", "-y", raw])
            with open(raw, encoding="utf-8", errors="replace") as handle:
                text, removed = scrub_srt(handle.read(), patterns)
            clean = os.path.join(scratch, f"clean-{index}.srt")
            with open(clean, "w", encoding="utf-8") as handle:
                handle.write(text)
            cleaned[index] = clean
            total_removed += len(removed)
            if removed:
                say(type="log", level="info", text=f"Track {index}: removed {len(removed)} cue(s)", detail="\n".join(removed[:50]))

        # Every stream in its original order; a cleaned track takes the place
        # of the one it came from, keeping its language and flags.
        command = [ffmpeg, "-v", "error", "-i", source]
        for index in cleaned:
            command += ["-i", cleaned[index]]
        command += ["-map_metadata", "0", "-c", "copy"]
        extra = {index: n + 1 for n, index in enumerate(cleaned)}
        subtitle_position = 0
        for stream in streams:
            index = stream["index"]
            if index in cleaned:
                command += ["-map", f"{extra[index]}:0"]
                pos = f"s:{subtitle_position}"
                command += [f"-c:{pos}", "mov_text" if is_mp4 else "srt"]
                language = (stream.get("tags") or {}).get("language")
                if language:
                    command += [f"-metadata:s:{pos}", f"language={language}"]
                flags = [name for name in ("default", "forced") if (stream.get("disposition") or {}).get(name)]
                command += [f"-disposition:{pos}", "+".join(flags) if flags else "0"]
            else:
                command += ["-map", f"0:{index}"]
            if stream.get("codec_type") == "subtitle":
                subtitle_position += 1
        command += ["-metadata", f"{TAG}={job['script']['version']}"]
        if is_mp4:
            command += ["-movflags", "+faststart+use_metadata_tags", "-f", "mp4"]
        else:
            command += ["-f", "matroska"]
        command += ["-y", output]
        say(type="progress", fraction=0.95, message="Putting the cleaned tracks back")
        run(command)

    say(type="result", message=f"Removed {total_removed} cue(s) from {len(cleaned)} track(s)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - the app shows this as the reason the repair failed
        print(str(error), file=sys.stderr)
        sys.exit(1)
