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

Every check in the list below is a module of its own, and so is every repair.
**Settings → Checks & repairs** lists all forty, each with a switch and a plain
English account of what it looks for, how it decides, and what you give up by
turning it off. Nothing is hidden behind a general "strictness" dial: if a rule
is reporting something you do not care about, you can read exactly what it does
and switch that one rule off.

Switching a **check** off means it is never reported. Switching a **repair** off
means the problem is still reported, and listed as something the app will not
fix — which is how you run a library you only ever want remuxed, by turning off
*Re-encode video* and leaving every check running.


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

### Checks and repairs are modules

The rules are not one long function with a settings object threaded through it.
Each one is a small file that says what it is for before it says what it does:

```
src/shared/plex/modules/
  framework.ts     What a check is, what a repair is, and how they talk
  engine.ts        Runs them: checks, then repairs, then the plan
  registry.ts      Every module, in the order it runs
  checks/          One file per thing that can be wrong with a file
  repairs/         One file per thing that can be done about it
```

A **check** reads a file and reports findings. A **repair** reads what the
checks concluded and says what to do. Neither imports the other: a check raises
a finding code, a repair declares which codes it answers, and that is the whole
of the coupling. It is what lets either be switched off without the other
noticing.

Checks run in registry order and each is handed what the ones before it
concluded, because some questions cannot be asked until an earlier one is
answered — whether a subtitle track can stay depends on the container, and the
container depends on what the video and audio turned out to be. The order *is*
the pipeline, rather than a dependency graph pretending the rules are
independent.

Adding a rule means adding a file beside the others and a line in the registry.
Nothing else in the app has to know it exists; it appears in Settings with its
own switch because it described itself.

The checks and repairs that ship with the app are **read-only**: they can be
switched off, but not edited or deleted. They are code rather than settings, so
there would be nowhere to keep a change to one.

### Writing your own rule

**Settings → Checks & repairs → New rule** opens an editor with two views of
the same rule, switchable at any time.

**Blocks** is the one that opens first. Everything a rule can ask about is
listed down the side; drag one into the rule, or click it, and it becomes a
condition with a dropdown of only the comparisons that fit — so `video.codec
above 3` is unwritable rather than an error message. Repairs drag in the same
way, conditions can be dragged to reorder, and nothing needs a mouse: every
item in the list is a button too.

Two things the blocks are honest about. The order of conditions **does not mean
anything** — they all have to hold — so dragging one above another is tidying,
not logic. And the four explanations are written from the rule itself unless
you fill them in, so a three-line rule still appears in Settings with the same
account of itself as a built-in one.

**Text** is the same rule as lines. Editing in blocks rewrites the text as you
go, and that rewrite is canonical: the steps come out in a fixed order — name,
explanations, conditions, report, fixes — however they were typed. Your
comments survive, attached to the step they sat above, so a note about a
condition follows that condition when it moves. What is not kept is the order
you wrote the steps in and how you spaced them, because the block editor has no
way to express "this fix was written above that condition" and inventing one
would be inventing meaning the language does not have.

A rule is a few lines, one step per line:

```
name Flag DivX video
when video.codec in divx, dx50, xvid
report blocker "DivX video"
       "No mainstream client can decode DivX, so the server re-encodes
        it on every play."
fix transcode-video
```

| Line | What it does |
| --- | --- |
| `name` | What the rule is called. Required. |
| `when` | One question about the file. Several `when` lines must *all* hold. At least one is required, so a rule cannot match the whole library. |
| `report` | `info`, `warning` or `blocker`, then a title and an optional explanation, both in quotes. |
| `fix` | `transcode-video`, `remux`, `drop-track` or `extract-subtitles`. |
| `summary` / `does` / `how` / `off` | Your own wording for the four explanations. Written for you from the rule if you leave them out. |

Lines starting with `#` are ignored, and an indented line continues the one
above it, so a long explanation can be laid out as a paragraph. The whole
script is un-indented before it is read, so indenting all of it is harmless —
only being indented *further* than the script makes a line a continuation.

A `when` line is a subject, a comparison and a value — `video.codec`,
`audio.channels`, `subtitle.language`, `container`, `file.path` and the rest,
compared with `is`, `is not`, `in`, `not in`, `contains`, `above`, `below`,
`at least`, `at most`, `is set` or `is missing`. The editor lists every subject
with what it means, and says your rule back in English as you type it, which is
how you notice it says something other than what you meant.

Two things worth knowing. A question the file does not answer is never true —
`video.profile is not high` is false on a file that does not say what its
profile is, and `is missing` is the way to ask about silence. And a question
about tracks is asked of every track and matches if any one answers: the tracks
that answered are the ones the finding points at, and the ones `drop-track`
acts on.

**Nothing in a rule is executed.** There are no expressions, no variables and
no way to call anything: a script is read into a handful of comparisons, and
the app compares values. A rule directs the repairs the app already has — it
cannot describe a new way of writing a file, so every ffmpeg command that runs
was still built by code that ships with PlexFixer.

### Changing what a file says about itself

Everything else in this app decides for itself what a file needs. **Edit
metadata**, on any row, is the one place it is told. A viewer knows things the
file does not say and the rules cannot work out — which audio track they
actually want, that the title is wrong, that a track labelled English is really
the director talking.

The screen holds the file's own tags (title, year, summary, genre, and the
series fields for an episode) and every track, with its name, language, and
whether it plays or appears without being chosen. What you change is shown as a
plan and costed before anything is written, then queued like any other repair.
Nothing is stored while you type: an edit is made, previewed and applied in one
go, so there is no pending edit to go stale against a file that changed
underneath it.

What you set beats what the rules decided about the same track — that is the
point of being able to set it — but the two are merged rather than one
replacing the other, so naming a track does not quietly undo a language tag a
check corrected.

Flags and language tags on an MP4 are still written straight into the header.
A **title, or any file tag, is text of any length**, so it cannot be slotted
into the space the old one occupied: setting one rewrites the file. The plan
says so before you agree to it.

**Looking a title up.** Settings → Metadata takes a credential for
[themoviedb.org](https://www.themoviedb.org), and the search box on the
metadata screen fills the tags in from a result.

TMDB hands out two and does not make it obvious that either will do: an **API
Key**, which is 32 characters and travels in the address, and an **API Read
Access Token**, which is much longer and travels in a header. Paste whichever
you have — PlexFixer reads the shape and works out which it is. A token is
never put in a URL, so nothing that logs one gets to keep it.

Either way it is yours rather than one shipped with PlexFixer: TMDB gives them
away for the asking and asks that they not be passed around, which rules out
putting one inside a program anybody can open. Without one the screen still
works — you type the fields yourself.

The search term is guessed from the file name (`Casino.Royale.2006.1080p…`
becomes *Casino Royale*, 2006) and is editable. **Only that term is sent.**
Nothing else about the file leaves the machine, and nothing is looked up unless
you press the button — there is no background lookup over a library.

The request is made from Rust rather than from the page. The page is allowed to
talk to this app and to nothing else, and widening that to reach an outside host
would widen it for everything else the page could ever be made to do; a command
with the host written into it cannot be pointed anywhere else. PlexFixer is not
endorsed by or affiliated with TMDB.

### Subtitles

**Subtitles**, on any row, is a workshop for one film. It is deliberately not
four screens for the four things it does, because a person opening it has one
subtitle in mind and everything they might want is the same sentence: get a
subtitle from somewhere, see whether it fits, change it, save it.

Nothing it does writes to the film. Every result is a sidecar `.srt` beside it,
named the way Plex looks for one — `<film>.<language>[.forced].srt` — and a name
already taken gets a number rather than being overwritten, because a file
already there is somebody's. A sidecar is what you want anyway: every client
renders text without the server doing any work, which is the whole reason this
app prefers one to a track muxed into the file.

**Where a subtitle comes from.** Any text track already in the file, any sidecar
already beside it, a search on OpenSubtitles, or the audio itself. Picture
subtitles (PGS, VobSub) are listed and cannot be used — there is no text in them
to compare, translate or write out.

**Finding one.** Settings → Subtitles takes an OpenSubtitles API key, which is
yours rather than one shipped with PlexFixer for the same reason as the TMDB
one. Searching needs only the key; *downloading* spends one of a daily
allowance that belongs to an account, so that needs a username and password
too. Both go into `settings.json` in the clear, like every other credential
here — PlexFixer has no keychain integration, and that is worth knowing before
you type a password in. Leave it empty and everything else here still works.

The search sends the film's **hash** as well as its title. The hash is its size
plus its first and last 64 KB, which identifies this exact encode: a result
marked *matches this file* was uploaded for this encode and its timing is
usually right to the frame, where a result matched by name is a subtitle for a
film of that title and its timing is anybody's guess.

**Checking the timing.** This is the part with real work in it. There is no
metadata anywhere that says whether a subtitle matches a film, but there are
two timelines — when somebody is speaking, and when a line is on screen — and if
the subtitle belongs to this cut they line up.

PlexFixer finds the first by running ffmpeg's `silencedetect` over the
original-language audio track and inverting what it reports: the gaps between
the silences are, near enough, the dialogue. Then it correlates the two and
reports one of four things — in step, out by a constant amount, drifting, or not
this film at all. Drifting is the one a person notices last and which no shift
can fix: a subtitle timed against a 25 fps broadcast transfer laid over a 23.976
fps source is nearly five minutes out by the end of a feature while the first
ten minutes look fine. Each of the frame rate conversions that actually happen
is tried, and the one that lines up is named. **Move the lines to match**
applies what it found; nothing is on disk until you save.

The report carries a confidence, and the percentage beside it is reported next
to the share of the film that has sound in it, because without that baseline it
is not a measurement: on a talkative film a subtitle picked at random begins on
speech about three quarters of the time.

The check runs ffmpeg where the film is, so it works with a remote host
switched on.

**Writing one from the audio.** This is Whisper's job and not a language
model's. Chat endpoints take text; Ollama serves text and vision models and has
no speech-to-text endpoint of any kind, so there is nowhere to send the
request. "Local" here therefore means a `whisper.cpp` build and a `ggml` model
file on your own disk, which Settings points at; the hosted alternative is a
*speech* endpoint — Groq or OpenAI — which is a different address from the chat
endpoint below, even at the same vendor.

A hosted endpoint takes 25 MB at a time, so a film goes up in pieces. The cuts
land in a silence rather than on the clock, because a cut through the middle of
a word gives both halves a fragment the model guesses at and the guesses arrive
in the subtitle as invented sentences. Whisper also pads silence with the most
common line in its training data — subtitle credits, in whatever language — and
those are dropped rather than written out.

Sending audio needs the audio on this machine, so a hosted transcription does
not work with a remote host switched on. A local Whisper does.

**Both files PlexFixer will fetch.** On Windows, Settings → Subtitles offers
the two whisper.cpp builds that matter — the CUDA one, which runs on the
graphics card and is the difference between minutes and an afternoon on a
feature film, and the processor-only one — downloads it, checks it against the
SHA-256 GitHub publishes for the asset, unpacks it into the app's own folder
and points itself at the `whisper-cli` inside. Nothing is installed
system-wide; removing it is deleting one folder. The CUDA archive carries the
CUDA runtime with it, so there is no toolkit to install — only a current NVIDIA
driver. It is 736 MB and unpacks to about 1.4 GB, which the panel says before
you press anything.

On macOS there is nothing to download: whisper.cpp publishes an xcframework for
embedding and no command-line build. `brew install whisper.cpp` is the answer
there, and PlexFixer finds that one on PATH without anything being typed in.
The same resolution order applies everywhere — a path named in Settings, then a
build PlexFixer installed, then whatever is on PATH — so a binary you installed
yourself is used as readily as one fetched here.

The **model** PlexFixer will fetch too. Nothing installs one,
the file names say nothing about what is in them, and the obvious choice is a
three-gigabyte download that transcribes a film slower than watching it, so
Settings → Subtitles lists six of them with what each is for and downloads the
chosen one into the app's own folder. Each is pinned to the size and the
SHA-256 published for it, hashed as it arrives, and thrown away if it does not
match — the same discipline the bundled ffmpeg downloads are held to, and for
the same reason: a model file is read by a binary this app then runs. The
address is not something the page can name. It asks for a *file*, whose shape
is checked, and the URL is built on the native side from a prefix compiled into
the binary; a redirect is followed only to Hugging Face's own hosts.

If you keep models somewhere of your own, the path field underneath still takes
one directly.

**Translating one.** This is where a language model belongs, and three shapes
are supported: the OpenAI chat shape that half the industry copied (so Groq,
Together, LM Studio and llama.cpp's own server all answer), Anthropic's
messages, and **Ollama**, which is the one that matters for a model on your own
machine — no key, no bill, nothing leaving the house. Ollama gets a model
picker rather than a text box, because a local install has whichever models
somebody pulled under names only that machine knows.

Lines go to the model forty at a time with a few already-translated lines in
front as context. That is not an optimisation, it is what makes the translation
correct: Russian drops pronouns and marks gender on the verb, `Вы` and `ты` are
both "you" but only one is polite, and a two-word line is routinely the second
half of the sentence before it. A model shown a scene gets those right and a
model shown one line cannot.

Every batch goes out numbered and is counted back. A model asked for forty
lines occasionally returns thirty-nine, having merged two short ones, and a
subtitle whose lines have shifted by one is far worse than one that failed —
nothing about it looks wrong until you watch it. A batch that does not
reconcile is asked again for the lines that are missing and then split; only
after that does a line give up and keep its original wording, which is a
visible imperfection rather than a quiet one.

Whisper can also translate to English by itself, in the same pass as the
transcription, with no language model involved at all. That is a genuinely
different route to an English subtitle from Russian audio — one model's guess at
what was said in English, against two models' guesses at what was said and then
what it means — so both are offered and which is better depends on the film.

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
ffmpeg exits cleanly *and* the result re-probes with the streams it should have
and runs as long as the original — a file that stops early is refused, and the
original stays where it is.

The original is never the first thing to go. Replacing a file under its own
name is a single rename; when the container changes, the repaired file is put
in beside the original before the original is moved or removed, so a move that
fails leaves two files rather than none. Nothing that was not asked about is
touched: if a different file already has the name the repair would take —
repairing `Movie.mkv` beside an unrelated `Movie.mp4` — that file is left alone
and the repaired one is written as `Movie (2).mp4`. A subtitle sidecar that
already exists is kept, not overwritten.

### Where the repaired file goes

Settings holds the standing answer — beside the original with a suffix, over the
original, or into a separate folder with the library's folder structure
mirrored inside it. Any repair that will re-encode video asks before it starts,
a single file included, and the question it asks is *where*: as Settings says,
beside each original, replacing each original, or into a folder chosen right
then. The choice applies to that run and nothing else; Settings is not touched.

This is asked at the start of a re-encode and not of a remux because a re-encode
is the repair where the standing answer is most often the wrong one. It takes
hours, it is not lossless, and "put this one on the scratch disk" or "write it
somewhere I can watch it before it goes near the library" is a decision made
when starting it, not months earlier in Settings.

The folder is created before ffmpeg is pointed at it. ffmpeg does not create the
folder it is told to write into: it opens the output file and stops with *No
such file or directory*, which is how a 27 GB transcode into a fresh output
folder used to fail in under a second.

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
the version, the Tauri and webview under it, which ffmpeg is in use and where
that binary came from, the hardware encoders that were actually detected, and the
folder settings live in. **Copy details** puts the same lines on the clipboard, which
is what a useful bug report starts with; the version now appears in the per-file and
per-job diagnostic reports too.

### What's new

The first time a version runs, it says what changed in it — a short screen,
one paragraph per change, with a link to the full notes on the releases page.
It is shown once per version and never again, and an update that skipped a
release shows each release it skipped rather than only the last. A machine
that has no recorded version, which is a fresh install and also anyone
updating from before this screen existed, is shown the release it just
installed and nothing older.

The same notes are in **About → What's new** whenever you want them back.

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

With it on, **Add folder…** and **Add files…** open a browser for the *remote*
filesystem — the native dialog can only see this machine. It scans the folder
you are standing in, or, if you click media files to choose them, just those.
Everything downstream behaves as it always has: the same analysis, the same
plans, the same temporary-file, re-probe, back-up and promote dance, all
happening on the far end. The encoders reported are the remote machine's,
confirmed by test encodes there, so a force transcode uses the NAS's NVENC
rather than this laptop's idea of it.

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

Every download is pinned to a release tag and held to a SHA-256; one that does
not match is discarded and the fetch fails. These binaries go inside a signed
installer, so what ships is what was chosen, not what a URL served that day.
To move to a newer build, change the tag and the checksum together in
`scripts/fetch-ffmpeg.mjs` — GitHub lists a `digest` for every release asset.

`qt-faststart` is fetched as source and compiled, because none of those builds
ships one. It moves an MP4's index in a single pass where ffmpeg rewrites the
whole file twice, and the app uses it when moving the index is the entire
repair. It needs a C compiler on the machine doing the fetch — one Mac builds
both macOS architectures, and Windows uses the MSVC that building PlexFixer
already requires. Without one the fetch says so, notes it in the platform
folder so it does not ask again, and ffmpeg does the job as before.

Windows and Linux use FFmpeg's *shared* builds, so the folder holds two small
executables plus the libav* libraries they load from beside them — half the
size of bundling two static binaries that each embed the whole library. Both
macOS builds are static, and the two architectures come from different
upstreams: arm64 from Vodes/ffmpeg-mt, which has libplacebo with Vulkan and
MoltenVK linked in, and x64 from shaka-project, which does not. libplacebo is
the only thing in ffmpeg that can read a Dolby Vision RPU, so an Intel Mac
reports the profile 5 conversion as unavailable instead of doing it wrong.

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
npm run dist
```

That builds for the machine it runs on. Other targets are named:

| Command | Builds |
| --- | --- |
| `npm run dist:mac-arm` | macOS, Apple Silicon |
| `npm run dist:mac-intel` | macOS, Intel |
| `npm run dist:mac` | both Macs, one after the other |
| `npm run dist:mac-universal` | one Mac app with both architectures in it |
| `npm run dist:win` | Windows x64 — **only on Windows** |

Artifacts land in `release/`:

| Artifact | Platform |
| --- | --- |
| `PlexFixer_<version>_aarch64.dmg` | macOS, Apple Silicon |
| `PlexFixer_<version>_x64.dmg` | macOS, Intel |
| `PlexFixer_<version>_x64-setup.exe` | Windows x64 |
| `PlexFixer_<version>_<arch>.app.tar.gz` + `.sig` | macOS update packages |
| `PlexFixer_<version>_x64-setup.nsis.zip` + `.sig` | Windows update package |

The ffmpeg binaries for the target are downloaded if they are not already
there, so no separate fetch step is needed; `npm run fetch:ffmpeg -- --all`
still gets all three platforms at once if you would rather have them up front.
Each build embeds only its own platform's: a `beforeBundleCommand` hook stages
the right folder and fails the build if it is empty, rather than shipping an
installer that cannot probe anything.

The build signs macOS apps with the single Developer ID certificate in your
keychain, naming it so the log says which one was used. `--no-sign` skips it,
and `--identity="Developer ID Application: …"` picks one on a machine that has
several. Update packages are signed with `TAURI_SIGNING_PRIVATE_KEY`, which the
build insists on rather than quietly producing a release no client can update
to; `--no-updater` is the way to build without it.

### One Mac builds both Macs

Xcode carries the SDKs for both macOS architectures, so an Apple Silicon Mac
builds the Intel app and the other way round. The only thing needed is the Rust
target, which `scripts/dist.mjs` installs itself.

`dist:mac-universal` is the other way to cover both: a single app with both
slices, which also has to carry both ffmpeg builds, so its DMG is roughly the
two separate ones added together. Two downloads are usually the better trade.

### Windows is built on Windows

Tauri compiles a native binary and needs the MSVC toolchain, so unlike the
electron-builder setup this replaced there is no Wine trick that produces a
Windows installer from a Mac. `npm run dist:win` refuses to run anywhere else
rather than producing something broken.

Two ways to get one:

- Run `npm run dist:win` on a Windows machine with Rust, Node and the Visual
  Studio build tools. The same script runs there.
- Push a tag: `.github/workflows/release.yml` builds macOS (both
  architectures) and Windows on their own runners, then uploads everything to
  that tag as a **draft** release. Run it from the Actions tab without a tag to
  test a build without publishing anything.

The workflow needs `TAURI_SIGNING_PRIVATE_KEY` as a repository secret, or the
build fails on the update packages. macOS signing in CI is optional and off
unless `APPLE_CERTIFICATE` (a base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD` and
`APPLE_SIGNING_IDENTITY` are set; without them the runner produces an unsigned
build, which is worth knowing before publishing one.

Exporting that `.p12` is a Keychain Access job: select the certificate *and*
the private key beneath it, Export 2 items, and give the file a password.
Keychain asks for two passwords in a row — first the one protecting the file,
then your login password to release the key from the keychain — and typing the
login password at the first prompt is the usual way this goes wrong.

Checking that password afterwards needs care, because the obvious tool lies.
Keychain writes the file with RC2-40 and 3DES, which OpenSSL 3 moved into its
legacy provider, so a Homebrew `openssl` answers `Mac verify error: invalid
password?` for a password that is perfectly correct. Use the LibreSSL macOS
ships, which reads the file as written:

    /usr/bin/openssl pkcs12 -in developer-id.p12 -noout -nokeys

`MAC verified OK` means the password is right. Note that an unsupported-cipher
failure is not a wrong password: the MAC is checked first, so a complaint about
`RC2-40-CBC` means the password was already accepted. CI never goes near
OpenSSL — the runner imports the file with `security import`, which has no such
trouble.

### Publishing a build

A version bump is not finished until its notes are written. The screen the app
shows on first run reads `src/shared/release-notes.ts`, newest entry first, and
a test fails when the version in `package.json` has no entry there — so the
bump commit carries the notes with it. The text is the short version: a
headline and a paragraph per change, with the full story left to the release
on GitHub.

The build writes to `release/` and stops there. `--publish` attaches what it
just built to a GitHub release:

```bash
npm run release:win    # on Windows: build, upload, refresh the manifest
npm run release:mac    # on a Mac: both architectures, same thing
node scripts/dist.mjs win --publish --tag=v0.2.1   # a tag other than the version's
```

The tag defaults to `v<version>` from `tauri.conf.json`; `--tag=` overrides it
and `--repo=owner/name` overrides the `origin` remote. A tag with no release
yet gets one, as a **draft** — publishing it is a decision about notes and
timing, not one a build should make for you. Credentials come from the GitHub
CLI, so `gh auth login` is the whole setup and none of these scripts handles a
token.

It uploads only the files that run produced, never the contents of `release/`,
and then rebuilds `latest.json` to cover **every** platform on the release, not
just the one it built. The signatures already attached are fetched first — a
few hundred bytes each, not the packages — and merged with this build's, so
publishing Windows from a Windows machine leaves the Macs on the updater
rather than withdrawing them. Publishing in either order gives the same
result.

A platform only reaches the updater if its update package was signed, which
needs `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
on the machine that builds it. Build with `--no-updater` and the installer
still publishes; it just is not offered as an update.

### Setting up a second build machine

Windows is built on Windows, so the signing key has to be there too. It lives
in `plexfixer.env` at the root of the clone, which the build scripts read on
their own — there is no shell command to remember, and nothing to set up that
survives a reboot:

1. Copy `plexfixer.env` from the machine that already has it. It is
   gitignored, so it is not in the clone and will not be committed. Any way of
   moving a file works; it never needs to go through a service.
2. Put it beside `package.json` in the clone.
3. `npm ci`, then `npm run release:win`.

The build prints the names of what it loaded and never the values, so its
output can be pasted into an issue. Anything already set in the environment
wins over the file, which is how CI keeps using its own secrets. If the file
is not there, the build says so and names the file to copy.

### The updater manifest

The updater reads one `latest.json` covering every platform, so it can only be
written once all the builds exist in one place:

```bash
node scripts/release-manifest.mjs --tag v0.2.1
```

It reads `release/`, pairs each update package with its `.sig`, and writes
`release/latest.json`. Platforms that are not there are left out — an entry
whose download 404s is worse than no entry — and it says which ones those were.
The release workflow runs this after collecting every runner's artifacts.

### Signing, and not notarizing

macOS builds are signed if a Developer ID certificate is available. They are
**not notarized** — notarization needs a paid Apple Developer account, and
PlexFixer does not have one. That is a deliberate, settled choice, not a gap
waiting to be filled, and the build clears any stray Apple credentials from the
environment so it cannot happen by accident.

The consequence is that macOS blocks the app on first launch, and since Sequoia
Control-clicking it no longer offers a way past. The DMG therefore ships
**Allow PlexFixer to open.command** beside the app: it clears the quarantine
flag from `/Applications/PlexFixer.app`, confirms the signature is still intact
(and refuses if it is not), then opens it. That is the supported path, not a
stopgap. The equivalent by hand is:

```bash
xattr -dr com.apple.quarantine /Applications/PlexFixer.app
```

or System Settings → Privacy & Security → Open Anyway. macOS quarantines the
`.command` too, so a Mac that blocks the script as well needs one of those two.

Windows builds are unsigned, so SmartScreen shows "Windows protected your PC"
on first run; More info → Run anyway is the way past.

## Tests

```bash
npm test
```

The suite covers the compatibility rules, the default-track resolver and the
ffmpeg command builder. It also includes integration tests that synthesise real
media with ffmpeg, run the generated repair commands and re-probe the output to
confirm the problems are actually gone — those are skipped automatically when
ffmpeg is not installed.

The subtitle code is tested the same way, in two halves. The arithmetic — cue
parsing, the correlation, the chunking, the batching — is checked against
timelines and payloads built by hand, including a saved reply from each service
so that a wire format is never learned from production. What that cannot check
is the one place the code meets text it did not write, so a second file
synthesises audio with silence in known places, runs ffmpeg's real
`silencedetect` over it, and confirms the silence comes back where it actually
was. A regex against a remembered log format is a guess, and a wrong guess here
produces a film with no silence in it anywhere and a timing check that
confidently reports that nothing matches.

## Layout

```
src/
  shared/           Pure, dependency-free domain logic (unit tested)
    types.ts        Domain model
    languages.ts    ISO 639 normalisation
    plex/rules.ts   The compatibility tables
    plex/tracks.ts  Default/forced track resolution
    plex/analyze.ts The door the modules are behind
    plex/modules/   One file per check, one per repair, and the engine
    plex/modules/script/  The little language rules are written in
                          (parse, serialize, evaluate, edit — the blocks
                           and the text are two views of one structure)
    plex/probe.ts   ffprobe output, normalised
    plex/command.ts The ffmpeg arguments a plan becomes
    plex/metadata.ts What a person may change by hand
    plex/destination.ts Where one run writes, as against where Settings says
    tmdb.ts         Addresses and answers for themoviedb.org
    subtitles/      Finding, timing, transcribing and translating subtitles
      cues.ts         The cue list every subtitle becomes, whatever it arrived as
      hash.ts         The file hash that identifies this exact encode
      silence.ts      Where the talking is, from where the silence is not
      sync.ts         Whether a subtitle follows the audio, and by how much it does not
      providers/      One file per subtitle service, pure request and reply
      asr.ts          Whisper, local and hosted — not a language model's job
      models.ts       The ggml models: what there is, and fetching one
      llm.ts          Chat endpoints: OpenAI-shaped, Anthropic, Ollama
      translate.ts    Batching lines out and counting them back
      audio.ts        The one part that runs ffmpeg
      service.ts      The one part that knows a host exists
    release-notes.ts What changed, and which versions a run is shown
    plex/runner.ts  Running repairs: queue, progress, promotion, backups
    plex/ssh.ts     The ssh transport, and the host that speaks it
    host.ts         What the code needs from a machine, local or remote
  renderer/         React UI
    bridge/         `window.plexfixer`, over Tauri commands
src-tauri/          The native side, in Rust
  src/host.rs       Files and the filesystem walk
  src/process.rs    Long-running ffmpeg, streamed and stoppable
  src/settings.rs   The settings file
  src/environment.rs What this machine's ffmpeg can actually do
  src/net.rs        The one door out: allowed hosts, and the ones Settings names
  src/models.rs     Fetching a Whisper model: streamed, hashed, and only from one place
  src/whisper.rs    Installing whisper.cpp itself: the same, plus unpacking it
```

**Rust does only what a native process must** — spawn ffmpeg, walk a
filesystem, open a dialog, write a file — and TypeScript keeps every decision.
The analysis engine, the compatibility rules and the repair planner run in the
webview, which is why they are also the part with the tests.

The analysis is deliberately pure: probe output in, findings and a plan out.
That is what makes it testable, and what lets the UI show exactly which ffmpeg
command will run before anything touches the disk.

## Caveats

- Compatibility tiers are judgement calls about a *typical* client fleet, not a
  Plex-published matrix. Settings exist for the two that most often differ:
  whether HEVC counts as compatible (on by default), and the H.264 level
  ceiling.
- Dolby Vision profile 5 can be converted to plain HDR10, which is off by
  default (Settings → Compatibility). It is a full re-encode through
  libplacebo, and the Dolby Vision layer is deliberately dropped: profile 5
  has no HDR10 base layer, so relabelling it 8.1 leaves a file that still
  renders with the wrong colours. The conversion is only offered where the
  active ffmpeg can actually run libplacebo, which PlexFixer checks by running
  it rather than by reading the filter list. Profile 7 is still reported and
  not repaired — its enhancement layer is a different job.
- The bundled ffmpeg binaries are **GPL** builds (that is what carries NVENC and
  libx264); PlexFixer's own code is MIT. They are shipped as separate
  executables and invoked as subprocesses, never linked. Sources and versions are
  listed in [NOTICE.md](NOTICE.md).

## License

MIT
