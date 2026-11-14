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
| macOS arm64 | [Vodes/ffmpeg-mt](https://github.com/Vodes/ffmpeg-mt) | release tag `v9.0.2-r1`, `ffmpeg-9.0.2-macos-arm64.tar.zst` (GPL v3, static, libplacebo + MoltenVK) |
| macOS x64 | [shaka-project/static-ffmpeg-binaries](https://github.com/shaka-project/static-ffmpeg-binaries) | release tag `n8.1.2-2`, `ffmpeg-osx-x64` / `ffprobe-osx-x64` |

Both macOS architectures come from one upstream build, configured
`--enable-gpl --enable-version3` with libx264, libx265 and VideoToolbox. That
is deliberate: 0.1.1 took the two architectures from two different projects,
and only one of them turned out to be redistributable.

`scripts/fetch-ffmpeg.mjs` is the single place these URLs are defined; change
them there to pin a different build.

The binaries are not committed to this repository. They are downloaded at build
time by `npm run fetch:ffmpeg`, so a clone of this repository contains no
GPL-licensed material.

### Withdraw the 0.1.1 macOS arm64 artifacts

PlexFixer **0.1.1** shipped a macOS arm64 FFmpeg configured `--enable-gpl
--enable-nonfree`, taken from `eugeneware/ffmpeg-static` `b6.1.1`. A nonfree
build may be used but **not redistributed**, so `PlexFixer-0.1.1-arm64.dmg` and
`PlexFixer-0.1.1-arm64-mac.zip` should not be distributed further. The x64
artifacts from that release are unaffected.

0.1.2 replaces both macOS architectures with the GPL builds listed above and
carries no nonfree code.

### How this is now prevented

Every FFmpeg build embeds its configure line as a plain string, so the licence
can be read out of a binary without running it. `scripts/lib/ffmpeg-license.mjs`
does that, and

- `npm run fetch:ffmpeg` refuses to install a nonfree build (`--allow-nonfree`
  overrides it for local use), and
- the `afterPack` hook fails the build if one is about to be packaged, or if a
  binary's configure line cannot be read at all — an unverified licence is not
  a licence, and this is the last gate before an installer is published.

The reader looks for the `configuration: ` marker FFmpeg itself prints and
takes the whole NUL-terminated string, falling back to a free-standing flags
string for builds that print the two separately. It returns nothing unless it
has seen a complete line. The first version instead matched the flags with a
regex, which was wrong in both directions — it read nothing from a build
configured without `--prefix`, and on a build whose `--extra-version` held a
quoted URL it stopped at the quote and reported a GPL build as LGPL. A line
truncated a little earlier would have been reported as shippable, which is
precisely the mistake this is here to catch.

## Tauri

The application is built with [Tauri](https://github.com/tauri-apps/tauri)
(MIT/Apache-2.0) and renders in the operating system's own webview — WKWebView
on macOS, WebView2 on Windows — so no browser engine is bundled with it. The
Rust crates it links are MIT or Apache-2.0; `cargo tree` in `src-tauri` lists
them for a given build.
