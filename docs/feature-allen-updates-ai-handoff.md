# AI handoff: `feature/allen-updates`

Briefing for an AI coding assistant picking up this branch. It describes the state of the code **after** the branch and the invariants that matter, so you can change it without re-deriving them. The human-facing summary is [feature-allen-updates.md](feature-allen-updates.md).

- Branch: `feature/allen-updates`, 3 commits on `main` (`aca27d6`, `d669d51`, `05740e2`), about 32 files.
- Full diff: `git diff main...feature/allen-updates`
- Checks: `npm run typecheck && npm test`. Both pass at the branch head (18 files, 179 tests).

## Architecture recap

| Layer | Where | Notes |
|---|---|---|
| Electron main | [src/main/](../src/main/) | IPC handlers in [ipc.ts](../src/main/ipc.ts), ffprobe/ffmpeg, the job runner, settings JSON in `userData` |
| Preload bridge | [src/preload/index.ts](../src/preload/index.ts) | `window.plexfixer.*`; the only renderer→main surface (`contextIsolation`, no node in the renderer) |
| Renderer | [src/renderer/src/](../src/renderer/src/) | React 19. Nearly all state lives in [App.tsx](../src/renderer/src/App.tsx); the table is [ResultsTable.tsx](../src/renderer/src/components/ResultsTable.tsx) |
| Shared, pure | [src/shared/](../src/shared/) | Analysis, facets/status, library helpers, launch-arg parsing. Unit tested in [tests/](../tests/) with vitest |
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

## 3. Repairs use the stored probe

- The main process **no longer caches** results (the old `resultsByPath` / `scanRootByPath` maps are gone). The renderer sends `jobs:enqueue` with `RepairRequest[] = { file: MediaFile, scanRoot? }` plus a `RepairMode`.
- `currentProbe()` in main/ipc.ts reuses the stored probe only if `stat` shows the same `mtimeMs` **and** size. It otherwise re-probes, or skips the file if it's gone. `MediaFile.modifiedMs` is set in [probe.ts](../src/main/ffmpeg/probe.ts).
- The plan is recomputed with **current** settings at enqueue time.
- **Removed**: `AppSettings.defaultMode`, the `ModeOverrides` type, `resolveMode` / `getModeOverrides` / `setModeOverride`, the `overrides:get/set` IPC, and the Default mode field in SettingsPanel. [src/main/settings.ts](../src/main/settings.ts) ignores a leftover `modeOverrides` key on load and drops it on the next write. The mode is chosen per action: `safe-remux` or `force-transcode`. A multi-file force transcode asks for confirmation.

## 4. Status model (what the Status column and tiles show)

`fileStatus(result)` in [src/shared/plex/facets.ts](../src/shared/plex/facets.ts). The first rule that matches wins:

| Order | Status | Rule | UI label / badge tone |
|---|---|---|---|
| 1 | `passed` | `verdict === 'ok'` (no blocker or warning finding) | "passed" / `ok` |
| 2 | `manual` | `plan.unresolved` has a finding with `severity !== 'info'` | "needs you" / `fail` |
| 3 | `reencode` | `plan.requiresTranscode` | "re-encode" / `warn` |
| 4 | `fixable` | `plan.strategy !== 'none'` | "fixable" / `info` |
| 5 | `manual` | fallback: a problem with no plan | |

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
