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

**Scan** a folder and every file in it is probed and kept in the app's
library, which persists between launches. Scanning only reads. Re-scanning a
folder updates its files and drops the ones that are gone; changing a setting
re-evaluates the whole library without re-probing anything. A search box
narrows the list by any part of the path. **Clear list** empties the library —
PlexFixer forgets what it has scanned, and the files themselves are untouched.

Nothing is written until you ask, per file or for the selection:

| Action | Behaviour |
| --- | --- |
| **Repair** | Use the file's own mode — see *Repair modes* below. |
| **Safe remux** | Apply every fix that is a stream copy. Skips files needing a re-encode. |
| **Force transcode** | Also re-encode the video, with GPU acceleration where available. |

### Repair modes

Every file has a mode, which is what **Repair** does to it:

| Mode | Behaviour |
| --- | --- |
| **Report only** | Never write. The file is analysed and flagged, and a repair is recorded as skipped. |
| **Safe remux** | The default: every fix that is a stream copy. |
| **Force transcode** | Also re-encode the video where a remux cannot fix it. |

The mode comes from the most specific setting that covers the file: its own, then
the nearest folder above it with one of its own, then the global default in
Settings. So the whole `Anime` folder can be set to force-transcode while one
episode inside it stays on report-only.

Set a folder, or a single file, from the row's details in the library; Settings →
*Repair modes* lists every override, and adds folders that are not in
the library yet. A row whose mode is not the default says so next to its
*details* link.

**Safe remux** and **Force transcode** are one-off actions and ignore the mode —
except report-only, which is never written to by either.

A repair uses the stored scan only if the file on disk has not changed since
(same size and modification time); otherwise it probes the file again first.

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

PlexFixer needs `ffmpeg` and `ffprobe`. `npm run fetch:ffmpeg` downloads them
into `resources/bin/<platform>-<arch>/`; failing that the app falls back to
whatever is on `PATH` (Homebrew's `ffmpeg` works), and Settings → FFmpeg lets
you point at a specific binary. Add `--force` to replace binaries already
there, or name a platform (`linux-x64`) to fetch one we do not ship.

Windows and Linux use FFmpeg's *shared* builds, so the folder holds two small
executables plus the libav* libraries they load from beside them — half the
size of bundling two static binaries that each embed the whole library.

The fetch refuses a build configured `--enable-nonfree`, which may be used but
not redistributed; `--allow-nonfree` overrides that for local use, and the
packaging hook refuses it again if one would be shipped — or if a binary's
configure line cannot be read at all, since an unverified licence is not a
licence. See [NOTICE.md](NOTICE.md).

You can also launch it scanning a folder:

```bash
npm run dev --volume "/Volumes/Media/Movies"
```

`--volume` can be repeated, and a bare path works too.

## Surveying a library

Before trimming the bundled ffmpeg down to only what is needed, find out what a
real library actually contains:

```
node scripts/survey-library.mjs "/Volumes/Media/Movies" "/Volumes/Media/TV"
```

It walks the folders recursively, probes every media file, and tallies
containers, video and audio codecs with their profiles, pixel formats, codec
tags, levels, channel layouts, subtitle formats, cover art, interlacing, HDR and
Dolby Vision. The summary prints to stdout and the full detail is written to
`plexfixer-survey.json`.

Symlinked folders are followed (libraries are often assembled out of them) and
each folder is visited once, so a link pointing back up the tree neither loops
nor double-counts. The run reports how many files each root contributed and how
many folders it walked — a root showing `0 media files` is a wrong path, not a
walk that stopped early. Folders it could not read are listed rather than
skipped in silence.

It uses PlexFixer's bundled ffprobe when it can find one, otherwise ffprobe from
`PATH`; set `FFPROBE=/path/to/ffprobe` to choose explicitly. Useful flags:
`--json <file>` to change the output path, `--jobs N` for probe concurrency,
`--all-files` to probe every extension rather than the known media ones, and
`--verbose` to print every folder as it is walked.

## Building installers

```bash
npm run fetch:ffmpeg -- --all
```

`--all` fetches the platforms `npm run dist` builds: macOS arm64, macOS x64 and
Windows x64.

```bash
npm run dist
```

`npm run dist:mac` and `npm run dist:win` build one platform. Installers land in
`release/`:

| Artifact | Platform |
| --- | --- |
| `PlexFixer-<version>-arm64.dmg` / `-arm64-mac.zip` | macOS, Apple Silicon |
| `PlexFixer-<version>-x64.dmg` / `-mac.zip` | macOS, Intel |
| `PlexFixer-<version>-Setup.exe` | Windows x64 |

Each build embeds only its own platform's ffmpeg, so `npm run fetch:ffmpeg --
--all` has to run first. An `afterPack` hook fails the build if the binaries did
not land where the app looks for them, rather than shipping an installer that
cannot probe anything.

Building the **Windows** installer from macOS needs Wine, which electron-builder
downloads itself (pinned to Wine 11 in `electron-builder.yml`). That build is
x86_64, so on Apple Silicon it needs Rosetta 2:
`softwareupdate --install-rosetta`.

macOS builds are signed if a Developer ID certificate is in your keychain, and
are **not** notarized unless you supply notarization credentials — without
notarization, other Macs will need a right-click → Open on first launch.

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
  whether HEVC counts as compatible (on by default), and the H.264 level
  ceiling.
- Dolby Vision profile 5 and 7 are reported, not repaired — converting them
  correctly needs tooling beyond ffmpeg.
- The bundled ffmpeg binaries are **GPL** builds (that is what carries NVENC and
  libx264); PlexFixer's own code is MIT. They are shipped as separate
  executables and invoked as subprocesses, never linked. Sources and versions are
  listed in [NOTICE.md](NOTICE.md).

## License

MIT
