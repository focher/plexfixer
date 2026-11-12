# AI handoff: `feature/allen-updates`

Briefing for an AI coding assistant picking up this branch. It describes the state of the code **after** the branch and the invariants that matter, so you can change it without re-deriving them. The human-facing summary is [feature-allen-updates.md](feature-allen-updates.md).

- Branch: `feature/allen-updates` (commits `aca27d6`, `d669d51`, `05740e2`, `e459374`), now **merged into `main`** and released as 0.1.6.
- **A later change on `main` matters here:** `047b534` "Bring back per-folder and per-file repair modes" (released as 0.1.7) restored the repair-mode system this branch had removed. This document describes the code **as it is on `main` after that commit**. See [section 3](#3-repairs-and-repair-modes).
- Diffs: `git diff aca27d6~1..05740e2` for this branch, `git show 047b534` for the mode restoration.
- Checks: `npm run typecheck && npm test`. Both pass on `main` (19 files, 193 tests).

## Architecture recap

| Layer | Where | Notes |
|---|---|---|
| Electron main | [src/main/](../src/main/) | IPC handlers in [ipc.ts](../src/main/ipc.ts), ffprobe/ffmpeg, the job runner, settings JSON in `userData` |
| Preload bridge | [src/preload/index.ts](../src/preload/index.ts) | `window.plexfixer.*`; the only renderer→main surface (`contextIsolation`, no node in the renderer) |
| Renderer | [src/renderer/src/](../src/renderer/src/) | React 19. Nearly all state lives in [App.tsx](../src/renderer/src/App.tsx); the table is [ResultsTable.tsx](../src/renderer/src/components/ResultsTable.tsx) |
| Shared, pure | [src/shared/](../src/shared/) | Analysis, facets/status, repair-mode resolution, library helpers, launch-arg parsing. Unit tested in [tests/](../tests/) with vitest |
| IPC channel names | [src/shared/ipc.ts](../src/shared/ipc.ts) | Kept in shared so preload can import them without pulling in main-process code |

Conventions to keep: comments explain *why* and not *what*. Pure logic goes in `src/shared` with a test. Imports use `.js` suffixes and the `@shared/*` / `@renderer/*` aliases.

## 1. Library persistence (IndexedDB, renderer side)

- [src/renderer/src/library.ts](../src/renderer/src/library.ts): DB `plexfixer`, version `1`, object store `files`, `keyPath: 'path'`.
- The record is `LibraryEntry { path, file: MediaFile, scannedAt, scanRoot? }`.
- **The probe (`MediaFile`) is stored, never the analysis.** Verdicts depend on settings. `analyzeEntry()` in App.tsx recomputes from the probe, cached in a `WeakMap<LibraryEntry, {settings, result}>` keyed on entry identity plus the **settings object identity**.
  - A settings change produces a new object, so everything re-analyses.
  - A replaced entry is a new object, so that row re-analyses.
- `writeLibrary(put, remove)` does both in one transaction. `loadLibrary()` is `getAll()`.
- Bootstrap (the first `useEffect` in App) loads settings and the library together. It **merges** the stored entries *under* anything already in state, because a scan started from launch args can stream rows in before IDB opens. It logs `Loaded N files from the library` with `console.info`.
- **The origin must stay stable.** IndexedDB is per origin, so [electron.vite.config.ts](../electron.vite.config.ts) sets `server: { port: 5173, strictPort: true }` for the renderer. Production loads `file://`, a different origin from dev, so the dev and packaged builds have separate libraries. That is expected.
- `scanRoot` is the folder a file was found under. It's used to mirror trees in output-directory mode (`scanRootFor` in [src/main/jobs/output.ts](../src/main/jobs/output.ts)) and by "Refresh all" (`refreshRoots()` in App). **Don't overwrite it with a file's own parent directory.**

## 2. Scan streaming protocol

Main side, `runScan` in [src/main/ipc.ts](../src/main/ipc.ts):
- It walks inputs with `collectMediaFiles` ([src/main/scan/walk.ts](../src/main/scan/walk.ts)), then probes with `min(8, concurrency*2)` workers.
- After each file it sends `scan:progress` → `ScanProgressEvent { scanId, processed, total, currentPath, result? }`. `result` is the `AnalysisResult` (with `scannedAt` and `scanRoot`) when the probe succeeded.
- At the end it sends `scan:complete` → `ScanCompleteEvent { scanId, inputPaths, errors, foundPaths, cancelled }`. **There is no `results` array any more.** Results arrive only through progress events.

Renderer side, the second `useEffect` in App.tsx:
- `onProgress` pushes `entryFromResult(result)` into a local `pending` buffer and schedules `flush()` in **250 ms**. A flush is one `setLibrary` merge plus one `writeLibrary` transaction. This keeps a large library from re-sorting on every file.
- `onComplete` computes `stalePaths(libraryRef.current.keys(), inputPaths, foundPaths, cancelled)` ([src/shared/library.ts](../src/shared/library.ts)), then calls `flush(remove)`.
  - `libraryRef` may lag the latest flush. That's safe, because streamed paths are always in `foundPaths` and so are never stale.
  - A **cancelled scan removes nothing.**
- The renderer generates `scanId` with `crypto.randomUUID()` and stores it in `scanIdRef` **before** invoking `scan:start`. Otherwise a fast scan's events could arrive before the id is known and be dropped. Events for any other `scanId` are ignored.
- Quitting mid-scan keeps everything flushed so far, so at most the last ~250 ms of results is lost.

## 3. Repairs and repair modes

### Repairs use the stored probe (from this branch)

- The main process **doesn't cache** results (the old `resultsByPath` / `scanRootByPath` maps are gone). The renderer sends `jobs:enqueue` with `RepairRequest[] = { file: MediaFile, scanRoot? }` and an **optional** `RepairMode`.
- `currentProbe()` in main/ipc.ts reuses the stored probe only if `stat` shows the same `mtimeMs` **and** size. It otherwise re-probes, or skips the file if it's gone. `MediaFile.modifiedMs` is set in [probe.ts](../src/main/ffmpeg/probe.ts).
- The plan is recomputed with **current** settings at enqueue time.

### Repair modes (removed by this branch, restored on `main` by `047b534`)

A `RepairMode` is `'report' | 'safe-remux' | 'force-transcode'`. Every file has one, resolved from the most specific setting that covers it.

- **Resolution** lives in [src/shared/mode.ts](../src/shared/mode.ts), which is pure and shared by main and the renderer so they can't disagree:
  - `resolveMode(path, overrides, fallback)` → `{ mode, source: 'file' | 'folder' | 'default', from? }`. An override on the exact path wins. Otherwise the **nearest** ancestor folder with an override wins, otherwise `settings.defaultMode`.
  - A folder must match on a separator boundary, so `/Media/Anime2` doesn't inherit from `/Media/Anime`. Trailing separators are ignored.
  - **Windows paths** (a backslash or drive letter) compare case-insensitively and across `\` / `/`. POSIX paths stay case-sensitive.
  - `findOverrideKey(path, overrides)` returns the *stored* key for a path that may be spelled differently. Use it rather than `overrides[path]` when editing an override.
  - `repairModeFor(path, overrides, fallback, explicit?)` is the mode a job actually runs in. `explicit` wins, **except that `report` always wins**: a file or folder set to Report only is never written to, however the repair was started.
  - `MODE_LABEL` holds the display names. Tests are in [tests/mode.test.ts](../tests/mode.test.ts).
- **Storage**:
  - `AppSettings.defaultMode` defaults to `'safe-remux'` in [src/shared/defaults.ts](../src/shared/defaults.ts).
  - Overrides (`ModeOverrides = Record<absolutePath, RepairMode>`; a key may be a file or a folder) live in the settings JSON beside `settings`, in [src/main/settings.ts](../src/main/settings.ts) (`getModeOverrides` / `setModeOverride(path, mode | null)`).
  - `resetSettings()` **keeps** the overrides.
  - IPC: `overrides:get` / `overrides:set` → `window.plexfixer.overrides.get()` / `.set(path, mode | null)`, where `null` clears.
- **Enqueue**: `jobs:enqueue` resolves each file with `repairModeFor(file.path, overrides, settings.defaultMode, mode)`. The runner ([src/main/jobs/runner.ts](../src/main/jobs/runner.ts)) records a `report` job as skipped rather than dropping it, so the Jobs tab explains why nothing happened.
- **Renderer**:
  - App loads `overrides` at bootstrap. It keeps `overridesRef` / `settingsRef` so the once-created `repair` callback reads current values, and `setMode(path, mode | null)` updates them.
  - `repair(paths, mode?)` asks for confirmation when more than one file would actually *run* in force-transcode. Report-only files don't count toward that.
- **Where users set or see modes**:
  - Toolbar: **Repair selected** (no `mode`, so each file uses its own), **Safe remux selected** and **Force transcode selected** (explicit `mode`).
  - Row details ([FileDetail.tsx](../src/renderer/src/components/FileDetail.tsx)): a "Repair mode" line naming the source, plus `ModePicker` selects for *This file* and *This folder*. Each select's "Inherit (…)" option names the inherited value.
  - Row ([ResultsTable.tsx](../src/renderer/src/components/ResultsTable.tsx)): a mode badge beside the reason link whenever `source !== 'default'`. In Report only, the row's wrench and bolt buttons are disabled.
  - Settings → **Repair modes** ([SettingsPanel.tsx](../src/renderer/src/components/SettingsPanel.tsx)): the default mode, every override (sorted by path) with its own select and a Remove button, and **Add folder…**.
  - The re-encode banner offers **Set this folder to Force transcode** when the library has a single root that isn't already in force-transcode.

## 4. Status model (what the Status column and tiles show)

`fileStatus(result)` in [src/shared/plex/facets.ts](../src/shared/plex/facets.ts). The first rule that matches wins:

| Order | Status | Rule | UI label / badge tone |
|---|---|---|---|
| 1 | `passed` | `verdict === 'ok'` (no blocker or warning finding) | "passed" / `ok` |
| 2 | `manual` | `plan.unresolved.some(needsYou)`: a blocker, or a warning with `remedy: 'manual'` | "needs you" / `fail` |
| 3 | `reencode` | `plan.requiresTranscode` | "re-encode" / `warn` |
| 4 | `fixable` | `plan.strategy !== 'none'` | "fixable" / `info` |
| 5 | `passed` | fallback: only advisory warnings remain, and nothing to do | "passed" / `ok` |

- **`needsYou(finding)`** ([facets.ts](../src/shared/plex/facets.ts)) decides rule 2. It's true for an unresolved **blocker**, or an unresolved **warning whose remedy is `manual`**. Those warnings are `preferred-audio-language-absent` ("No English audio track": the video is tagged English but every audio track is another language) and `subtitle-image-based` when the output must stay MKV. Warnings that only an optional re-encode would change (`video-codec-limited`, `video-level-too-high`, `video-interlaced` and so on) are advisory and **don't** count, so a file with only those and nothing to do is `passed`. Info notes never count. The hidden `'blocked'` facet uses the same helper.
- In the Plan column, a `manual` file shows a red **manual** badge. If a remux is also planned, the remux badge stays beside it, since that part still runs.
- `STATUS_ORDER`, `matchesStatus`, `countStatuses` (one increment per file, so the tile counts sum to the library) all derive from `fileStatus`. **Change the rule in one place only.**
- `verdict` (`ok|warn|fail|error`, from `verdictFor` in [analyze.ts](../src/shared/plex/analyze.ts)) still exists. It feeds rule 1 and the severity shown in the detail pane. It's no longer displayed directly.
- `summarizeReason()` ([reason.ts](../src/shared/plex/reason.ts)) still supplies the Why headline, the tooltip `detail` and the `others` count. Its `outcome` / `tone` fields are **no longer rendered**: the Plan column badge replaced them. Their tests remain.
- The `'blocked'` facet is still computed by `facetsFor` but is **removed from `FACET_ORDER`**, so it isn't a chip; it's identical to the `manual` status. `countFacets` initialises counts from `FACET_INFO` keys so hidden facets don't produce `NaN`.
- The re-encode banner (`needsTranscode` in App) uses `fileStatus === 'reencode'`, so it always equals the Re-encode tile.

## 5. Filter pipeline (App.tsx `useMemo` chain)

```
results (all, sorted by path, analysed)
  → searched       matchesSearch(path, query)        every word, case-insensitive
  → narrowed       status tile (single-select)       matchesStatus
                   Hide passed                       skipped when the Passed tile is active
  → facetCounts    countFacets(narrowed)             chip counts reflect what is left
  → visibleResults filterResults(narrowed, facets)   chips are ANY-of, not ALL-of
```

- Hide passed is persisted in `localStorage` under the key `plexfixer.hidePassed` via `readPref` / `writePref`, both wrapped in try/catch. It's a per-viewer UI preference, deliberately kept out of `AppSettings`.
- The tiles are `<button className="stat …" aria-pressed>`. Clicking the active tile clears it.
- The header select-all checkbox acts only on `visibleResults`.

## 6. Table and row interactions ([ResultsTable.tsx](../src/renderer/src/components/ResultsTable.tsx))

- **Expanding a row**:
  - Clicking anywhere on the row toggles it, *except* when the target is inside `button, input, select, a, label` or the user has a non-empty text selection.
  - The ▸ expander and the reason link (`+N more` / `details` / `hide`) also toggle it.
  - The detail pane is [FileDetail.tsx](../src/renderer/src/components/FileDetail.tsx).
- **Context menu**:
  - The row's `onContextMenu` calls `window.plexfixer.shell.fileMenu(path)`, which goes over IPC `shell:file-context-menu` to a native `Menu.buildFromTemplate(...).popup()` in main/ipc.ts.
  - The label is chosen by platform in main: `Reveal in Finder` / `Show in File Explorer` / `Show in Folder`.
  - The actions are `shell.showItemInFolder` and `clipboard.writeText`.
- **Plan column**: the `PLAN_BADGE` map by `plan.strategy`, with `title` = hint + `plan.costNote`. A finished-job badge appears beneath it.
- **Per-row refresh** (`refreshFile` in App, IPC `scan:rescan-file`):
  - Re-probes one file and keeps the existing `scanRoot`.
  - If the path is gone and a finished job renamed it (`job.outputPath`), it follows to the new path and moves the selection across.
  - If the file is gone with no rename, it drops the entry.
- **Refresh selected** (`refreshSelected` in App) runs `refreshFile` over the selection, 4 at a time. **It deliberately doesn't start a scan**: a scan would reset each file's `scanRoot` to its own parent directory. The toolbar shows *Refresh selected* whenever `selectedPaths.length > 0`, and *Refresh all* (a re-scan of `refreshRoots()`) otherwise.
- CSS lives in one file, [styles.css](../src/renderer/src/styles.css): dark theme tokens on `:root`, `.badge.{ok,warn,fail,info,neutral}`, a 7-column `.row` grid (status column 88px, or 82px at ≤1120px). `.finding` uses `align-items: flex-start` so the badges don't stretch.

## 7. Launch arguments and the dev script

- [src/shared/launch.ts](../src/shared/launch.ts) `parseLaunchArgs(args)` accepts `--volume <path>` (repeatable) and `--volume=<path>`. Unknown switches are ignored, because Chromium and Electron flags pass through here too. It's tested in [tests/launch.test.ts](../tests/launch.test.ts).
- `userArgs(argv)` in [src/main/openPaths.ts](../src/main/openPaths.ts) strips the executable, and in dev the app directory too. Main logs problems and missing volumes to stderr. The existing paths are queued and fetched once by the renderer via `app:initial-paths`.
- [scripts/dev.mjs](../scripts/dev.mjs) is what `npm run dev` runs. It forwards args after `--` to Electron, so both `npm run dev -- --volume X` and `npm run dev --volume X` work. It also deletes `ELECTRON_RUN_AS_NODE`, which VS Code terminals can set and which breaks Electron.
- Main-process changes need a restart of `npm run dev`. Renderer changes hot-reload.

## 8. Toolchain

- TypeScript `^7.0.2`. Both `tsconfig.node.json` and `tsconfig.web.json` dropped `baseUrl` and made `paths` `./`-relative, because TypeScript 7 removed `baseUrl`. [src/renderer/src/env.d.ts](../src/renderer/src/env.d.ts) declares `*.css` modules.
- `formatAgo` (the "Scanned … ago" column) lives in [src/shared/time.ts](../src/shared/time.ts) and is re-exported from `renderer/src/format.ts`. Row icons are in [icons.tsx](../src/renderer/src/components/icons.tsx).

## Gotchas when changing things

- Adding a field to the analysis needs no migration: it's recomputed. Adding a field to `MediaFile` means **old IDB entries won't have it** until re-scanned, so treat it as optional. Bump `DB_VERSION` only for store or index changes.
- Don't reintroduce `results` on `ScanCompleteEvent`. The renderer would write every entry twice.
- Keep status logic in `fileStatus`. The tiles, row badges, banner and Hide passed all depend on it agreeing with itself.
- **Status and mode are independent.** `fileStatus` says what a file *needs*. The repair mode says what a repair is *allowed* to do. A "Re-encode" file in Safe remux mode is skipped by Repair selected, and nothing in a Report only folder is ever written.
- Keep mode resolution in `src/shared/mode.ts`, and edit overrides by the key `findOverrideKey` returns. Writing a second, differently spelled key for the same Windows path creates two overrides that fight.
- New IPC needs four edits: a channel in `shared/ipc.ts`, a handler in `main/ipc.ts`, a bridge method in `preload/index.ts` (the type flows from `PlexFixerApi`), and the renderer call.
- Anything persisted in the renderer's `localStorage` must tolerate storage being unavailable.

## Manual verification checklist

1. `npm run dev`, then scan a folder. Rows stream in while the banner counts up. DevTools → Application → IndexedDB → `plexfixer` → `files` grows as it goes.
2. Ctrl+C mid-scan, then `npm run dev` again. The scanned rows appear immediately, and the console shows `Loaded N files from the library`.
3. The tiles (Passed / Fixable / Re-encode / Needs you) add up to the total. Clicking one filters the table, and clicking it again clears it.
4. Turn Hide passed on and restart: it's still on. Clicking the Passed tile overrides it, and the switch shows as disabled.
5. Right-click a row to Reveal / Copy Path. Click a row to expand it. Clicking buttons or checkboxes doesn't toggle it.
6. Select a few rows and click Refresh selected: only those spin, and Refresh all returns when nothing is selected.
7. Delete a file on disk and re-scan its folder: its row disappears.
8. In a row's details, set *This folder* to Report only. Every row in that folder shows a "report only" badge, its wrench and bolt are disabled, and "Force transcode selected" on those rows records skipped jobs. Set one file back to Safe remux and only that row's badge changes. Settings → Repair modes lists both entries.
