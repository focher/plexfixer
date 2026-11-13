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
narrows the list by any part of the path, every column header sorts the table,
and the **Fixable** and **Blocked** chips split the library by whether
PlexFixer can repair a file at all. **Clear list** empties the library —
PlexFixer forgets what it has scanned, and the files themselves are untouched.

Nothing is written until you ask, per file or for the selection:

| Action | Behaviour |
| --- | --- |
| **Repair** | Use the file's own mode — see *Repair modes* below. |
| **Safe remux** | Apply every fix that is a stream copy. Skips files needing a re-encode. |
| **Force transcode** | Also re-encode the video, with GPU acceleration where available. |

### When a file is blocked

**Blocked** means no automatic repair applies. Opening the row says why, which
is a different question from what is wrong: DRM cannot be remuxed by anything;
Dolby Vision profile 5 needs its RPU metadata rewritten, which ffmpeg alone
cannot do and a plain re-encode would destroy; a file above the height ceiling
would have to be scaled down, which throws away detail permanently and which
Force transcode will *not* do either. Each reason comes with the move that is
actually open to you — a setting to change, a client preference, or a different
tool.

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

### About

**About** — in the app menu, or the button at the right of the title bar — reports
the version, the Electron and Chromium under it, which ffmpeg is in use and where
that binary came from, the hardware encoders that were actually detected, and the
folder settings live in. **Copy details** puts the same lines on the clipboard, which
is what a useful bug report starts with; the version now appears in the per-file and
per-job diagnostic reports too.

## Running it on the machine that holds the files

A remux copies every byte of the file. Across a mounted share that is two
network trips per byte — in to this machine and straight back out — so a repair
that takes seconds on the server can take many minutes over the mount. Settings
→ **Remote host** moves the work to where the disk is: `ffprobe` and `ffmpeg`
run there, and only the probe output and the progress come back.

PlexFixer shells out to your own `ssh`, so your keys, your `~/.ssh/config`, your
agent and your `known_hosts` all apply, and the app never sees a credential. It
never asks for a password — a prompt on a pipe would simply hang — so key-based
login has to work on its own (`ssh-copy-id user@host`). **Private key** points at
one key if you would rather not rely on the agent or the default identities;
with it set, only that key is offered, so a host that refuses it says so at once
instead of after trying everything else.

The first connection to a host is the question SSH normally asks at a prompt,
and a batch-mode connection cannot ask it. So the connection test asks instead:
it fetches the key the host offers, shows you every fingerprint, and writes them
to `~/.ssh/known_hosts` only when you press **Trust this host** — the same thing
typing `yes` at an ssh prompt does, with the fingerprint in front of you first.

What it will not do is accept a *changed* key. If there is already an entry for
that host and the key no longer matches, the test says so and stops: that is
either a rebuilt machine or something else answering at that address, and only
you know which. It prints the `ssh-keygen -R` line to run once you are sure.

**Test connection** reports what answered: the platform, both binaries with
their versions, and every POSIX utility the repair flow shells out to — `ls`,
`find`, `stat`, `df`, `mkdir`, `mv`, `rm`, `tail`, `head`, `base64` and `pkill`.
A missing one is named rather than discovered half way through a repair.

With it on, **Scan…** opens a browser for the *remote* filesystem — the native
dialog can only see this machine — and everything downstream behaves as it
always has: the same analysis, the same plans, the same temporary-file,
re-probe, back-up and promote dance, all happening on the far end. The encoders
reported are the remote machine's, confirmed by test encodes there, so a
force transcode uses the NAS's NVENC rather than this laptop's idea of it.

Two limits worth knowing: the remote host must be POSIX (Linux, macOS, BSD —
not Windows), and the in-place header edit, which rewrites a few bytes rather
than the file, only runs locally; a remote repair always rewrites the file.

## Measuring a repair

Every repair records what each stage cost: the check for an in-place edit,
ffmpeg itself, the second pass that moves an MP4 index to the front, re-probing
the output, and moving the finished file into place. The queue shows where the
time went as a bar per stage, with the throughput and the realtime multiple, and
names what the numbers point at — a network mount, an index move that is half
the run, a destination on another volume that forces the output to be copied
again rather than renamed.

The queue also shows *where* each repair has got to, as steps rather than a
number: **Connecting → Copying 42% → Verifying → Moving**, with the index move
and subtitle sidecars appearing when a file needs them. A percentage only
exists while ffmpeg is copying; the steps either side of it are the ones that
go quiet on a remote host or a slow link, and a bar sitting at 100% with no
explanation is indistinguishable from a repair that has died. A job running on
another machine says so on its own row, and if nothing is reported for 20
seconds the row says how long it has been silent rather than letting a stopped
bar speak for itself. A job that fails stays at the step it failed in.

**Copy diagnostics** (or **Save diagnostics…**) in the Queue tab collects the
build, the ffmpeg in use, the settings that shape repair cost, and the
measurements of every repair in the session into one plain-text block to paste
into a bug report. Each individual repair also still has its own **Copy
report**.

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
notarized if credentials are in the environment. `scripts/notarize.mjs` runs
after signing and submits the app to Apple; with no credentials it says so and
carries on, so a local build still works.

Either set of credentials works, in the gitignored `plexfixer.env`:

```
APPLE_ID=you@example.com
APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop   # appleid.apple.com, not your password
APPLE_TEAM_ID=XXXXXXXXXX
```

or an App Store Connect API key, which does not expire when the password does:

```
APPLE_API_KEY=/path/to/AuthKey_XXXXXXXX.p8
APPLE_API_KEY_ID=XXXXXXXX
APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

`PLEXFIXER_SKIP_NOTARIZE=1` skips it for one build. Notarization takes a few
minutes per architecture and the build waits for it; if it fails, the build
fails, because a half-notarized release is worse than an obviously unnotarized
one.

**Without** notarization, macOS blocks the app on first launch — and since
Sequoia, Control-clicking it no longer offers a way past. The DMG therefore
ships **Allow PlexFixer to open.command**, which clears the quarantine flag
from `/Applications/PlexFixer.app`, confirms the signature is still intact and
opens it. The equivalent by hand is:

```bash
xattr -dr com.apple.quarantine /Applications/PlexFixer.app
```

or System Settings → Privacy & Security → Open Anyway. Note that macOS
quarantines the `.command` too, so a user who cannot run it has to fall back to
one of those; notarizing is what actually removes the problem.

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
    remote/         The ssh transport and the connection check
    host.ts         Local or remote: where files live and binaries run
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
