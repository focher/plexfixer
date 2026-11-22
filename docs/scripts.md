# Check and repair scripts

Scripts are your own checks and repairs, written in any language. There are two kinds:

- **A check script** looks at a file and reports flags.
- **A repair script** is given a copy of a file and writes the repaired one.

PlexFixer works out what is wrong with each file and runs the repairs you have bound to those flags.

There are two worked examples:

- [examples/checks/subtitle-ads/](../examples/checks/subtitle-ads/) finds advert and credit lines in text subtitles.
- [examples/repairs/subtitle-scrub/](../examples/repairs/subtitle-scrub/) removes them.

Bind the check's flag to the repair and you have the whole loop.

## How the pieces fit

1. **Checks raise flags.** Every check reports problems as flags. That includes built-in checks, rules you wrote and check scripts, so flags look like `mp4-not-faststart`, `user.unscrubbed-subtitles` or `ext.subtitle-ads.adverts`. The chips above the library are these flags, and the status tiles are rules over them. You build those rules under *Settings → Statuses & catalog*.
2. **Each flag has one repair.** That is its built-in repair, your script, or nothing (report only).
   - To choose, open a check, or one of your rules, under *Settings → Checks & repairs*, and set the flag's **Repair**.
   - The shipped defaults are in [src/shared/plex/catalog/default.json](../src/shared/plex/catalog/default.json). Only your changes are stored, so any Reset button puts things back.
3. **Scripts run after ffmpeg.** A file with a flag bound to a script is first stream-copied by ffmpeg. Each bound script then reads the previous step's output and writes a new file.
4. **The output is checked before it replaces anything.** The last output is re-probed and checked like any repair's: video and audio still present, and the running time not cut short. Only then does it replace the original, with a backup if you keep them.
5. **Then it is checked again.** If the repair's *Re-run the checks* box is on, the finished file is probed and analysed again. Any flag the job meant to fix that is still there is reported as *still flagged*. Nothing is retried automatically.

## Adding a script

Everything is done under *Settings → Checks & repairs*, in the **Check scripts** and **Repair scripts** groups. You never need to find a folder or write a manifest: the app keeps both for you.

1. Press **New check script** or **New repair script**. A form opens.
   - **About it:** the name, a one-line summary, and what it does. The id is made from the name.
   - **How it runs:** what runs it (Python 3, Bash, Node.js, or another program) and the script itself. Either write it in the box, which starts with a working skeleton, or press **Choose a file…** to copy one in from your computer.
   - **Settings it takes:** each one becomes a control under the script, which you can change later without touching the script.
   - **Flags it can raise** (check scripts): the only flags it may report.
   - **Written for** (repair scripts): the flags it is meant to fix, offered first when you pick a flag's repair.
2. Press **Save script**. The script appears as *Not approved*.
3. Press **Review and approve…**. A native dialog shows the command, every file, and a fingerprint of them. Approve it only if you know what it does.
   - Approving a check script switches it on and adds its flags.
4. To change a script later, press **Edit script**. Saving withdraws the approval until you approve it again. **Delete script** is at the bottom of the form.

### The examples

Both ship inside the app. Press **Add the subtitle adverts example** under Check scripts and **Add the subtitle scrub example** under Repair scripts, then:

1. Approve both.
2. Rescan, so the check reads your files.
3. Open *Subtitle adverts*. Under *Flags it raises*, set the Repair of *Subtitle adverts* to *Script: Subtitle scrub*, and press **Save checks & repairs**.

### Saving changes

Changes to checks, repairs and scripts' settings are held until you press **Save checks & repairs** at the bottom of the section; **Discard changes** throws them away. Creating, editing, approving and deleting a script happen as soon as you press their buttons.

### Check scripts and scan time

A check script runs when a file is scanned. It is not run when you change a setting.

What it found is kept with the file, and analysis reads it back from there. An unchanged file is not checked again unless one of these has changed since it was last checked:

- the script's files;
- the script's settings.

So a slow script slows the first scan and nothing after it. Turning a check script off in Settings removes its flags immediately, without a rescan.

## Approval and safety

- **Approval covers exact files.** The approval is for the files as they were when you approved them.
  - The folder is hashed again every time the script is about to run (SHA-256 over every file's path and contents). If anything has changed, the script will not run until you approve it again.
  - Dotfiles are ignored. Symbolic links, more than 256 files, or more than 16 MB are refused.
- **Only the manifest decides what runs.** It sets the program and its arguments. Nothing about the media file is put on the command line; that all arrives on stdin.
- **Scripts run only on this computer.** While the remote host is switched on, scripts do not run.
- **The interpreter is not covered.** A script runs as you. Its interpreter, such as `python3`, is whatever is on your `PATH` when it runs, and that is not part of the fingerprint.

## Reference: what the form writes

This section is for script authors who want to know what is stored. The form writes it; nobody needs to.

Each script is a folder, `checks/<id>/` or `repairs/<id>/`, in PlexFixer's data directory, holding the script's files and a `plugin.json`:

```jsonc
{
  "protocol": 1,                         // always 1 for now
  "id": "subtitle-scrub",                // = the folder name
  "name": "Subtitle scrub",              // shown in Settings and the job log
  "version": "1.0.0",                    // passed to the script; handy for tagging output
  "summary": "One line for the list",
  "whatItDoes": "Plain English, for the expanded row",
  "howItWorks": "Plain English",
  "ifDisabled": "Plain English",
  "command": ["python3", "{pluginDir}/scrub.py"],  // {pluginDir} is the only substitution
  "timeoutSeconds": 600,                 // optional; the script is stopped after this
  "params": {                            // optional; edited under the script in Settings
    "patterns": { "type": "list", "label": "Remove cues matching", "default": ["www\\."] },
    "maxLines": { "type": "number", "label": "Longest cue", "min": 1, "max": 10, "default": 3 },
    "strict":   { "type": "boolean", "label": "Be strict", "default": false },
    "mode":     { "type": "string", "label": "Mode", "options": [{ "value": "a", "label": "A" }], "default": "a" }
  },
  "suggestedFlags": ["ext.subtitle-ads.adverts"]  // repair scripts: a hint shown in Settings; nothing is bound automatically
}
```

A check script's manifest also lists the flags it can raise. It may report only these:

```jsonc
"raises": [
  { "code": "adverts", "label": "Subtitle adverts", "hint": "Shown on the chip's tooltip",
    "category": "subtitle",      // file, video, audio, container, subtitle, tracks or custom
    "severity": "warning" }      // info, warning or blocker, unless a finding says otherwise
]
```

The flag's id is `ext.<script id>.<code>`. A check that runs longer than `timeoutSeconds` (60 by default) is stopped, and the file gets a note saying the check could not run.

## The protocol

### stdin

One JSON document is written to stdin, and then stdin is closed:

```jsonc
{
  "protocol": 1,
  "script": { "id": "subtitle-scrub", "version": "1.0.0" },
  "input": "/Movies/.plexfixer-…-Film.mp4",          // read this
  "output": "/Movies/.plexfixer-…-script1-Film.mp4",  // write the repaired file here
  "flags": ["user.unscrubbed-subtitles"],              // the flags on this file bound to you
  "params": { "patterns": ["www\\."] },               // your parameters, resolved
  "file": { "path": "/Movies/Film.mkv", "container": "matroska", "streams": [ ... ], "tags": { ... } },
  "ffmpegPath": "/…/ffmpeg",
  "ffprobePath": "/…/ffprobe",
  "preferredSubtitleLanguage": "eng"
}
```

`file` is the original file as it was scanned. `input` is ffmpeg's stream copy of it, which may have dropped tracks the target container cannot hold. Probe `input` yourself (with `ffprobePath`) if stream indexes matter.

### stdout

Write one JSON object per line:

```json
{"type":"progress","fraction":0.4,"message":"Cleaning track 3"}
{"type":"log","level":"info","text":"Removed 4 cues","detail":"…"}
{"type":"result","message":"Removed 4 advert cues"}
```

A line that is not one of these is kept as log text, so a stray `print` is harmless.

The script has worked when all of these are true:

- it exits with code 0;
- it writes exactly one `result` line;
- the `output` file exists.

On any failure the job fails, the original is left untouched, and the last 8 KB of stderr appear in the job log.

### What a check script says back

A check script gets the same document on stdin, with these differences:

- there is no `output`;
- `kind` is `"check"`.

Its one `result` line lists what it found:

```json
{"type":"result","findings":[{"code":"adverts","title":"2 advert lines in track 2","detail":"For example: …","streamIndexes":[2]}]}
```

- An empty `findings` list means the file is clean.
- Each finding's `code` must be one the manifest lists.
- `severity` and `remedy` are optional.

### Telling a done file from a new one

When the flag comes from a check script that looks at the content itself, like the subtitle-ads example, a repaired file simply stops being flagged.

When the flag comes from a rule that cannot see the content, it comes back on every scan unless something about the file changes. The usual trick is to tag the output (`-metadata my_tag=1` with ffmpeg, plus `-movflags +use_metadata_tags` for MP4) and add `when tag.my_tag is missing` to the rule that raises the flag. The example does exactly that.
