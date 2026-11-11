# What changed in `feature/allen-updates`

PlexFixer now keeps a **library** of everything it has scanned, and remembers it between launches. The library fills in live while a scan runs. Each file gets one plain status saying what happens next, and a library of thousands of files is easy to narrow down: click a status, hide what already passed, search, or filter by the kind of repair.

Nothing in this branch changes *what* the app decides is wrong with a file, or how it repairs one. The changes are to storing, showing, finding and acting on files.

---

## Your library is remembered

- Every file you scan is saved inside the app as soon as it has been examined. The app uses the browser database built into it (IndexedDB) for this, so nothing extra needs installing.
- Close the app and open it again, and the whole library is there straight away with no re-scan. This holds **even if you quit partway through a scan**: everything examined before you quit is kept.
- The app stores the facts about each file (its tracks, codecs and so on), not the verdict. When you **change a setting**, every file is re-evaluated against the new setting in an instant, without re-reading anything from disk.
- **Re-scanning a folder** updates its files and removes ones that are no longer there. A scan you cancel removes nothing, because it didn't get to look at everything.
- Scanning only reads. Nothing is written to your media until you ask for a repair.

## Watching a scan

Files appear in the table one by one as they are examined, while the "Scanning… N of M" banner counts up. You no longer wait for the whole folder to finish before seeing anything.

## What the statuses mean

Every file has exactly **one** status, and it says what happens next:

| Status | Meaning |
|---|---|
| **Passed** | No problems found. It plays directly in Plex as it is. |
| **Fixable** | A lossless remux fixes it: the file is rewrapped, with no loss of quality. It's quick. |
| **Re-encode** | Only re-encoding the video fixes it (slow, and changes the picture data). |
| **Needs you** | Something no automatic repair can fix. Open the row's details to see what. |

The four tiles at the top show these counts, which add up to your whole library. **Click a tile** to show only those files, and click it again to show everything.

Earlier versions labelled most files "Blocked", even when a quick remux would fix them. That's what "Fixable" now says.

## Finding files

The filters narrow the list in this order:

1. **Search**: type any part of a file or folder name. Every word must match, so `alien 1979` finds `…/Alien (1979)/Alien (1979).m4v`.
2. **A status tile**, as above.
3. **Hide passed**: the switch at the right of the search box hides files that passed. The app remembers it between launches. Clicking the *Passed* tile overrides it, because that's an explicit request to see passed files.
4. **"Show" chips**: filter by what the repair will do, such as *Move index to front*, *Adds AAC track* or *Language tags*. Selecting several shows files matching *any* of them.

## Working with files

- **See the details**: click anywhere on a row, or its *details* / *+N more* link. The detail pane lists every track, every finding with its severity, and the exact repair plan.
- **Right-click a row** for **Reveal in Finder** (on Windows, **Show in File Explorer**) and **Copy Path**.
- **The Plan column** shows the repair as a coloured badge: *nothing to do*, *remux*, *remux + AAC* or *re-encode*. Hover it for how long the repair takes.
- **Re-scan one file** with the ↻ button on its row. This is handy after a repair, to confirm it worked.
- **Refresh selected / Refresh all**: with files ticked, the toolbar button re-scans just those files. With nothing ticked it reads *Refresh all* and re-scans every folder in the library.

## Repairs

- Choose **Safe remux** or **Force transcode** each time you repair, for one file or for the selection.
- **Repair selected** instead uses each file's own mode — see *Repair modes* in the README. (This branch removed modes; they were put back afterwards.)
- If a file has changed on disk since it was scanned, the app examines it again before repairing, so it never works from out-of-date information.

## Launching with a folder

```bash
npm run dev --volume "/Volumes/Media/Movies"
```

`--volume` can be repeated, and a bare path works too. The app opens and scans those folders.

## Under the hood

- Upgraded to **TypeScript 7**.
- The development server is fixed to port **5173**. The saved library belongs to the address the app loads from, so if the port drifted the library would seem to vanish. The app now refuses to start on another port instead.
- The tests were extended and all pass (`npm test`).

For the technical detail, see [feature-allen-updates-ai-handoff.md](feature-allen-updates-ai-handoff.md).
