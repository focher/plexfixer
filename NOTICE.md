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
| Windows x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | release tag `autobuild-2026-10-31-12-59`, `ffmpeg-n8.1.3-27-g8dca1586f4-win64-gpl-shared-8.1.zip` |
| Linux x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | release tag `autobuild-2026-10-31-12-59`, `ffmpeg-n8.1.3-27-g8dca1586f4-linux64-gpl-shared-8.1.tar.xz` (not shipped; fetched by name only) |
| macOS arm64 | [Vodes/ffmpeg-mt](https://github.com/Vodes/ffmpeg-mt) | release tag `v9.0.2-r1`, `ffmpeg-9.0.2-macos-arm64.tar.zst` (GPL v3, static, libplacebo + MoltenVK) |
| macOS x64 | [shaka-project/static-ffmpeg-binaries](https://github.com/shaka-project/static-ffmpeg-binaries) | release tag `n8.1.2-2`, `ffmpeg-osx-x64` / `ffprobe-osx-x64` |

Both macOS architectures come from one upstream build, configured
`--enable-gpl --enable-version3` with libx264, libx265 and VideoToolbox. That
is deliberate: 0.1.1 took the two architectures from two different projects,
and only one of them turned out to be redistributable.

## mp4v2 (`mp4tags`)

PlexFixer bundles `mp4tags`, built from [mp4v2](https://github.com/enzo1982/mp4v2)
v2.1.3, as a **separate executable** invoked as a subprocess. No mp4v2 code is
linked into the application.

mp4v2 is distributed under the **Mozilla Public License 1.1**, which is in the
source archive as `COPYING`. The exact source PlexFixer compiles is pinned in
`scripts/lib/mp4tags.mjs` — one release tarball, checked against a SHA-256
before anything is built from it — and is available from the release page
above.

It is built rather than downloaded because mp4v2 publishes source and nothing
else: no project ships a prebuilt `mp4tags` for Windows or for either macOS
architecture. The build is CMake with `BUILD_SHARED=OFF`, so the tool carries
its own copy of the library and there is no shared object to ship beside it.

It exists to make a metadata edit instant. ffmpeg can only write a file's tags
by remuxing it, which reads and writes every byte to change two words; mp4v2
keeps free space beside the header and rewrites the chunk-offset tables when
the header grows, so the media data never moves. Without it the app writes tags
the way it always did, by rewriting the file.

Every download is pinned to a release tag and checked against a SHA-256 before
it is used, so a build either ships the bytes that were chosen or stops.
`scripts/fetch-ffmpeg.mjs` is the single place these URLs and checksums are
defined; change the tag and the checksum together to pin a different build.

The binaries are not committed to this repository. They are downloaded at build
time by `npm run fetch:ffmpeg`, so a clone of this repository contains no
GPL-licensed material.

## qt-faststart

PlexFixer also bundles `qt-faststart`, which moves an MP4's index to the front
in one read and one write — the job ffmpeg does by remuxing the file and then
rewriting the whole of it a second time. It is run as a subprocess like the
others, and the app works without it.

It is not taken from a build; none of the ffmpeg builds above ships one. It is
compiled here from `tools/qt-faststart.c` in FFmpeg's own source tree, pinned
to release `n8.1.3` and checked against its SHA-256. The file is self-contained
— standard C headers, nothing linked — and is **placed in the public domain**
by its author, Mike Melanson, so unlike the ffmpeg binaries it carries no
licence obligation.

| Component | Source | File |
| --- | --- | --- |
| qt-faststart | [FFmpeg](https://github.com/FFmpeg/FFmpeg) | release tag `n8.1.3`, `tools/qt-faststart.c` (public domain) |

Compiling it needs a C compiler on the machine that fetches: Apple's clang
covers both macOS architectures from one Mac, and Windows uses the MSVC that
building PlexFixer already requires. A machine without one simply does not get
it, and ffmpeg moves the index instead.

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
