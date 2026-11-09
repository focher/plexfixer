# Third-party components

PlexFixer's own source is MIT licensed. The binaries it bundles are not, and
they are listed here with their sources.

## FFmpeg

PlexFixer bundles `ffmpeg` and `ffprobe` as **separate executables**, invoked as
subprocesses. They are not linked into the application and no FFmpeg code is
compiled into it.

The bundled builds are configured with GPL components (libx264, and NVENC
support on Windows), and are therefore distributed under the
**GNU General Public License v3 or later**. FFmpeg's own source is available at
<https://ffmpeg.org/download.html>, and each build below links to its exact
upstream artifact and configuration.

| Platform | Source | Build |
| --- | --- | --- |
| Windows x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | `ffmpeg-n8.1-latest-win64-gpl-8.1.zip` |
| Linux x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | `ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz` |
| macOS arm64 | [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | release tag `b6.1.1`, `ffmpeg-darwin-arm64` (reports FFmpeg 6.0) |
| macOS x64 | [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | release tag `b6.1.1`, `ffmpeg-darwin-x64` (reports FFmpeg 6.0) |

`scripts/fetch-ffmpeg.mjs` is the single place these URLs are defined; change
them there to pin a different build.

The binaries are not committed to this repository. They are downloaded at build
time by `npm run fetch:ffmpeg`, so a clone of this repository contains no
GPL-licensed material.

## Electron

The application runs on [Electron](https://github.com/electron/electron) (MIT),
which embeds Chromium (BSD-style) and Node.js (MIT). Their full license texts are
included in every packaged build under `Resources/LICENSES.chromium.html` and
`Resources/LICENSE.electron.txt`.
