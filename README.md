# PlexFixer

A desktop app for macOS and Windows that checks whether your MKV and M4V files
will **direct play** on a remote Plex client — and fixes what it can without
re-encoding.

The problem it solves: a file can sit in your library looking fine and still
make the server transcode on every single play. The usual culprits are not
obvious from the filename — a PGS subtitle track flagged as default, an HEVC
stream tagged `hev1` instead of `hvc1`, 10-bit H.264, a `moov` atom at the end
of the file, or an audio track no client can decode. PlexFixer finds those,
explains why each one matters, and repairs the ones that can be repaired with a
stream copy.

It also fixes the quieter annoyance: **the wrong audio track playing**.
PlexFixer treats the video track's own language tag as the file's primary
language and makes sure exactly one audio track — in that language, and never a
commentary track — carries the default flag.

## What it checks

**Container**
- MKV, which forces a Direct Stream remux on browsers, Chromecast and several TVs
- MP4 files whose index (`moov` atom) sits at the end, so remote clients stall
- Containers outside Plex's reliable set

**Video**
- Codecs with no or patchy client support (VC-1, MPEG-4 Part 2, VP9, AV1, WMV…)
- 10-bit H.264 (High 10) — no consumer device has a hardware decoder for it
- H.264 levels above the configured ceiling (4.1 by default)
- 4:2:2 / 4:4:4 chroma, interlaced sources, anamorphic pixels, high ref-frame counts
- HEVC in MP4 carrying the `hev1` tag, which Apple clients refuse outright
- Dolby Vision profiles with no HDR10 fallback (profile 5 and 7)

**Audio**
- Lossless and legacy formats that are always transcoded (TrueHD, DTS-HD MA, PCM, WMA)
- Whether *any* track is one every client can play
- Channel counts above 5.1, which most clients downmix

**Subtitles**
- Image-based tracks (PGS / VobSub), which Plex burns in — turning a direct play
  into a full video transcode
- Styled ASS/SSA, which is burned in rather than converted
- Tracks that cannot be stored in MP4 at all

**Tracks and language metadata**
- Missing or non-standard language tags (`en-US`, `fra`, `English` → `eng`, `fre`)
- Missing, duplicated, or wrong-language default audio
- Default subtitles that should not be on, and forced tracks missing the forced flag

## What it does about it

Each file or folder has a **mode**:

| Mode | Behaviour |
| --- | --- |
| **Report only** | Analyse and explain. Never writes. |
| **Safe remux** (default) | Apply every fix that is a stream copy. Flag anything needing a re-encode. |
| **Force transcode** | Also re-encode the video, with GPU acceleration where available. |

The mode is set globally in Settings and can be overridden **per folder or per
file** — set the whole `Anime` folder to Force transcode, leave one episode on
Report only.

A "safe remux" never re-encodes video or discards audio. It rewraps the
container, moves the MP4 index to the front, fixes codec tags, corrects language
tags and default/forced flags, extracts text subtitles to `.srt` sidecars, and —
when nothing in the file is universally playable — **adds** an AAC track
alongside the originals rather than replacing them. If MP4 cannot hold one of
your audio tracks, the file stays MKV: losing a lossless track is worse than a
Direct Stream remux.

Originals are kept by default (moved to a `.plexfixer-backups` folder beside the
file). Output is written to a temporary file and only promoted into place after
ffmpeg exits cleanly *and* the result re-probes with the streams it should have.

### Transcoding

Force transcode uses hardware encoding where it is genuinely available —
**NVENC** on NVIDIA, Quick Sync on Intel, AMF on AMD, VideoToolbox on Apple
silicon — falling back to libx264/libx265. Availability is confirmed at startup
by running a real test encode, so a build that merely advertises `h264_nvenc` on
a machine with no NVIDIA driver will not be offered.

Decoding and filtering stay on the CPU, which keeps deinterlacing and scaling
correct on every build; the encode, which dominates the cost, runs on the GPU.

## Running it

```bash
npm install
```

```bash
npm run fetch:ffmpeg
```

```bash
npm run dev
```

PlexFixer needs `ffmpeg` and `ffprobe`. `npm run fetch:ffmpeg` downloads static
builds into `resources/bin/<platform>-<arch>/`; failing that the app falls back
to whatever is on `PATH` (Homebrew's `ffmpeg` works), and Settings → FFmpeg lets
you point at a specific binary.

You can also launch it with paths to scan:

```bash
npm run dev -- "/Volumes/Media/Movies"
```

## Building installers

```bash
npm run fetch:ffmpeg -- --all
```

```bash
npm run dist
```

`npm run dist:mac` and `npm run dist:win` build one platform. Installers land in
`release/`. Builds are unsigned unless you supply signing credentials to
electron-builder.

## Tests

```bash
npm test
```

The suite covers the compatibility rules, the default-track resolver and the
ffmpeg command builder. It also includes integration tests that synthesise real
media with ffmpeg, run the generated repair commands and re-probe the output to
confirm the problems are actually gone — those are skipped automatically when
ffmpeg is not installed.

## Layout

```
src/
  shared/           Pure, dependency-free domain logic (unit tested)
    types.ts        Domain model
    languages.ts    ISO 639 normalisation
    plex/rules.ts   The compatibility tables
    plex/tracks.ts  Default/forced track resolution
    plex/analyze.ts Findings and repair planning
  main/             Electron main process
    ffmpeg/         Binary discovery, ffprobe parsing, ffmpeg execution
    jobs/           Command building, output placement, queue, runner
    scan/           Filesystem walking
  preload/          The renderer's only bridge to the main process
  renderer/         React UI
```

The analysis is deliberately pure: probe output in, findings and a plan out.
That is what makes it testable, and what lets the UI show exactly which ffmpeg
command will run before anything touches the disk.

## Caveats

- Compatibility tiers are judgement calls about a *typical* client fleet, not a
  Plex-published matrix. Settings exist for the two that most often differ:
  whether HEVC counts as compatible, and the H.264 level ceiling.
- Dolby Vision profile 5 and 7 are reported, not repaired — converting them
  correctly needs tooling beyond ffmpeg.
- There is no maintained static ffmpeg build for macOS arm64 that is safe to
  pin, so Apple Silicon uses `PATH` (`brew install ffmpeg`).

## License

MIT
