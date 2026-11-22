# Repair scripts

A repair script is your own repair, written in any language. PlexFixer works out what is wrong with a file and runs the scripts you have bound to those problems. The script gets a copy of the file and writes the repaired one.

A worked example is in [examples/repairs/subtitle-scrub/](../examples/repairs/subtitle-scrub/). It removes advert and credit cues from text subtitles.

## How the pieces fit

1. **Checks raise flags.** Every check, built-in or a rule you wrote, reports problems as flags such as `mp4-not-faststart` or `user.unscrubbed-subtitles`. The chips above the library are these flags, and the status tiles are rules over them. Both can be edited, under *Settings → Statuses & catalog*.
2. **Each flag has one repair.** That is its built-in repair, your script, or nothing (report only).
   - To choose, open a check, or one of your rules, under *Settings → Checks & repairs*, and set the flag's **Repair**.
   - The shipped defaults are in [src/shared/plex/catalog/default.json](../src/shared/plex/catalog/default.json). Only your changes are stored, so any Reset button puts things back.
3. **Scripts run after ffmpeg.** A file with a flag bound to a script is first stream-copied by ffmpeg. Each bound script then reads the previous step's output and writes a new file.
4. **The output is checked before it replaces anything.** The last output is re-probed and checked like any repair's: video and audio still present, and the running time not cut short. Only then does it replace the original, with a backup if you keep them.
5. **Then it is checked again.** If the repair's *Re-run the checks* box is on, the finished file is probed and analysed again. Any flag the job meant to fix that is still there is reported as *still flagged*. Nothing is retried automatically.

## Installing a script

1. Under *Settings → Checks & repairs → Repair scripts*, press **Open repairs folder**. It is `repairs/` in PlexFixer's data directory. On macOS that is `~/Library/Application Support/com.timothyweaver.plexfixer/repairs/`.
2. Copy the script's folder in. The folder name must equal the manifest's `id`, using lower-case letters, digits and dashes only.
3. Press **Reload**. The script appears as *Not approved*.
4. Press **Review and approve…**. A native dialog shows the command, every file in the folder, and a fingerprint of them. Approve it only if you know what it does.
5. Bind a flag to it.
   - For the example, create a rule from [rule.txt](../examples/repairs/subtitle-scrub/rule.txt).
   - Then set that rule's flag's Repair to *Script: Subtitle scrub*.

## Approval and safety

- **Approval covers exact files.** The approval is for the files as they were when you approved them.
  - The folder is hashed again every time the script is about to run (SHA-256 over every file's path and contents). If anything has changed, the script will not run until you approve it again.
  - Dotfiles are ignored. Symbolic links, more than 256 files, or more than 16 MB are refused.
- **Only the manifest decides what runs.** It sets the program and its arguments. Nothing about the media file is put on the command line; that all arrives on stdin.
- **Scripts run only on this computer.** While the remote host is switched on, scripts do not run.
- **The interpreter is not covered.** A script runs as you. Its interpreter, such as `python3`, is whatever is on your `PATH` when it runs, and that is not part of the fingerprint.

## plugin.json

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
  "suggestedFlags": ["user.unscrubbed-subtitles"]  // a hint shown in Settings; nothing is bound automatically
}
```

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

### Telling a done file from a new one

A flag bound to your script comes back on every scan unless something about the file changes. The usual trick is to tag the output (`-metadata my_tag=1` with ffmpeg, plus `-movflags +use_metadata_tags` for MP4) and add `when tag.my_tag is missing` to the rule that raises the flag. The example does exactly that.
