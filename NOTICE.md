# Third-party components

PlexFixer's own source is MIT licensed. The binaries it bundles are not, and
they are listed here with their sources.

## FFmpeg

PlexFixer bundles `ffmpeg` and `ffprobe` as **separate executables**, invoked as
subprocesses. They are not linked into the application and no FFmpeg code is
compiled into it.

The bundled builds are configured with GPL components (libx264, libx265, and
NVENC support on Windows), and are therefore distributed under the
**GNU General Public License v3 or later**. FFmpeg's own source is available at
<https://ffmpeg.org/download.html>, and each build below links to its exact
upstream artifact.

Windows and Linux use the **shared** builds rather than the static ones. A
static `ffmpeg` and a static `ffprobe` each embed the whole of libav*, so
bundling both shipped the same 150 MB of codecs twice; shared, the executables
come to under a megabyte between them and the libraries are carried once. That
is 315 MB down to 191 MB on Windows, with no capability lost. The libraries
live in the same folder as the executables, which is where the loader looks
first.

| Platform | Source | Build |
| --- | --- | --- |
| Windows x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | `ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip` |
| Linux x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | `ffmpeg-n8.1-latest-linux64-gpl-shared-8.1.tar.xz` (not shipped; fetched by name only) |
| macOS arm64 | [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | release tag `b6.1.1`, `ffmpeg-darwin-arm64` (reports FFmpeg 6.0) — **see below** |
| macOS x64 | [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | release tag `b6.1.1`, `ffmpeg-darwin-x64` (reports FFmpeg 6.0) |

`scripts/fetch-ffmpeg.mjs` is the single place these URLs are defined; change
them there to pin a different build.

The binaries are not committed to this repository. They are downloaded at build
time by `npm run fetch:ffmpeg`, so a clone of this repository contains no
GPL-licensed material.

### The macOS arm64 build cannot be redistributed

The `b6.1.1` macOS **arm64** binaries are configured `--enable-gpl
--enable-nonfree`. A nonfree build may be used but **not redistributed**, so it
must not go into an installer. The macOS x64 binaries from the same release are
a plain GPL build and are fine; the two architectures come from different
upstream builds, which is why they differ.

PlexFixer 0.1.1 shipped a nonfree binary inside `PlexFixer-0.1.1-arm64.dmg` and
`PlexFixer-0.1.1-arm64-mac.zip`. Those artifacts should not be distributed
further. Until the arm64 source is replaced — with another build, or one built
from source without `--enable-nonfree` — no macOS arm64 installer should be
published.

This is now enforced rather than remembered. Every FFmpeg build embeds its
configure line as a plain string, so the licence can be read out of the binary
without running it: `scripts/lib/ffmpeg-license.mjs` does that, and

- `npm run fetch:ffmpeg` refuses to install a nonfree build (`--allow-nonfree`
  overrides it for local use), and
- the `afterPack` hook fails the build if one is about to be packaged.

## Electron

The application runs on [Electron](https://github.com/electron/electron) (MIT),
which embeds Chromium (BSD-style) and Node.js (MIT). Their full license texts are
included in every packaged build under `Resources/LICENSES.chromium.html` and
`Resources/LICENSE.electron.txt`.
