PlexFixer now keeps a library of everything it has scanned and remembers it
between launches. Nothing about *what* it decides is wrong with a file, or how
it repairs one, has changed — this is about storing, showing, finding and
acting on files.

Contributed by [Allen Furnas](https://github.com/focher/plexfixer/commits/main)
on `feature/allen-updates`.

## Your library is remembered

Every file is saved as soon as it has been examined, in the database built
into the app. Close it and reopen it and the whole library is there with no
re-scan — including everything examined before you quit partway through a
scan.

What is stored is the facts about each file, not the verdict, so changing a
setting re-evaluates the whole library instantly without re-reading anything
from disk. Re-scanning a folder updates its files and drops the ones that are
gone; a scan you cancel removes nothing, because it did not get to look at
everything.

Scanning still only reads. Nothing is written to your media until you ask.

## Results appear while the scan runs

Files land in the table one at a time as they are examined, counting up
against "Scanning… N of M", instead of nothing appearing until the whole
folder is done.

## One status per file

| Status | Meaning |
|---|---|
| **Passed** | Plays directly as it is. |
| **Fixable** | A lossless remux fixes it. |
| **Re-encode** | Only re-encoding the video fixes it. |
| **Needs you** | No automatic repair can fix it. |

The four tiles at the top count your whole library; click one to show only
those files. Earlier versions labelled most files "Blocked" even when a quick
remux would fix them — that is what "Fixable" now says.

## Finding files

- **Search** any part of a file or folder name; every word must match, so
  `alien 1979` finds `…/Alien (1979)/Alien (1979).m4v`.
- **Hide passed**, remembered between launches.
- The **Show** chips still filter by the kind of repair, and now combine with
  the search and status tiles.
- **Right-click a row** for Reveal in Finder / Show in File Explorer, and Copy
  Path.
- **Re-scan one file** with the ↻ button on its row, or refresh the selection
  or the whole library from the toolbar.

## Repairs are chosen per repair

Pick **Safe remux** or **Force transcode** each time, for one file or for the
selection.

**The global default mode and the per-folder and per-file mode overrides have
been removed.** Setting the whole `Anime` folder to Force transcode and leaving
one episode on Report only is no longer possible; the repair you pick is the
repair you get. Any overrides saved by an earlier version are ignored and
dropped the next time settings are written.

If a file has changed on disk since it was scanned, it is examined again
before being repaired, so a repair never works from out-of-date information.

## Launching with a folder

```bash
npm run dev --volume "/Volumes/Media/Movies"
```

`--volume` can be repeated, and a bare path works too.

## Under the hood

Upgraded to TypeScript 7. The development server is now pinned to port 5173 and
refuses to start elsewhere: the saved library belongs to the address the app
loads from, so a drifting port would make the library appear to vanish.

## Downloads

| File | Platform |
| --- | --- |
| `PlexFixer-0.1.6-arm64.dmg` | macOS, Apple Silicon |
| `PlexFixer-0.1.6-x64.dmg` | macOS, Intel |
| `PlexFixer-0.1.6-Setup.exe` | Windows x64 |

The `-mac.zip` files are there for the updater; the DMGs are the ones to
download.

The macOS builds are signed with a Developer ID but not notarized, so the
first launch needs right-click → Open rather than a double-click. The Windows
installer is unsigned and SmartScreen will warn once — choose More info → Run
anyway.
