import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AboutInfo,
  AnalysisResult,
  AppSettings,
  EnvironmentInfo,
  Job,
  MetadataEdit,
  ModeOverrides,
  OutputOverride,
  RepairMode,
  RepairRequest,
  ScanError
} from '@shared/types.js'
import { resolveMode } from '@shared/mode.js'
import { DEFAULT_SORT, nextSort, sortResults, type SortState } from '@shared/sort.js'
import ResultsTable from './components/ResultsTable.js'
import FileDetail from './components/FileDetail.js'
import { FilterMenu, HidePassed, SearchBox } from './components/LibraryControls.js'
import MenuButton from './components/MenuButton.js'
import BulkMetadataDialog from './components/BulkMetadataDialog.js'
import RepairDialog from './components/RepairDialog.js'
import { summarizeRepair, type RepairSummary } from '@shared/bulk.js'
import type { FileStatus, ResultFacet } from '@shared/plex/facets.js'
import { countFacets, countStatuses, fileStatus, filterResults, matchesStatus } from '@shared/plex/facets.js'
import AboutDialog from './components/AboutDialog.js'
import WhatsNewDialog from './components/WhatsNewDialog.js'
import RemoteBrowser from './components/RemoteBrowser.js'
import JobsPanel from './components/JobsPanel.js'
import SettingsPanel from './components/SettingsPanel.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { pruneSelection } from '@shared/selection.js'
import { latestNotes, notesSince, type ReleaseNote } from '@shared/release-notes.js'
import { formatBytes } from './format.js'
import { readPref, readText, writePref, writeText } from './prefs.js'

const OUTPUT_OVERRIDES_KEY = 'plexfixer.outputOverrides'

function readOutputOverrides(): Record<string, OutputOverride> {
  try {
    const raw = localStorage.getItem(OUTPUT_OVERRIDES_KEY)
    return raw ? (JSON.parse(raw) as Record<string, OutputOverride>) : {}
  } catch {
    return {}
  }
}
import {
  codecFilterActive,
  countCodecs,
  emptyCodecFilter,
  filterByCodec,
  type CodecFilter
} from '@shared/plex/codecs.js'
import {
  clearLibrary as clearStoredLibrary,
  entryFromResult,
  isWithin,
  loadLibrary,
  matchesSearch,
  stalePaths,
  writeLibrary,
  type LibraryEntry
} from './library.js'

type Tab = 'library' | 'jobs' | 'settings'

/**
 * Analysis per stored entry, recomputed only when the entry or the settings
 * object changes. Re-analysing a few thousand files on every row refresh would
 * be noticeable; a settings change re-analyses everything, which is the point.
 */
const analysisCache = new WeakMap<LibraryEntry, { settings: AppSettings; result: AnalysisResult }>()

function analyzeEntry(entry: LibraryEntry, settings: AppSettings): AnalysisResult {
  const cached = analysisCache.get(entry)
  if (cached && cached.settings === settings) return cached.result
  const result: AnalysisResult = {
    ...analyzeFile(entry.file, settings),
    scannedAt: entry.scannedAt,
    scanRoot: entry.scanRoot
  }
  analysisCache.set(entry, { settings, result })
  return result
}

/** The summary tiles, each also a filter. */
const STATUS_TILES: { key: FileStatus; label: string; tone: string; hint: string }[] = [
  { key: 'passed', label: 'Passed', tone: 'ok', hint: 'Show only files with nothing to do' },
  { key: 'fixable', label: 'Fixable', tone: 'info', hint: 'Show only files a lossless remux fixes' },
  { key: 'reencode', label: 'Re-encode', tone: 'warn', hint: 'Show only files that need their video re-encoded' },
  { key: 'manual', label: 'Blocked', tone: 'fail', hint: 'Show only files no automatic repair can fix' }
]

function readSort(): SortState {
  try {
    const raw = localStorage.getItem('plexfixer.sort')
    if (!raw) return DEFAULT_SORT
    const parsed = JSON.parse(raw) as SortState
    // Anything written by an older build, or by hand, falls back rather than
    // leaving the table sorted by a column that no longer exists.
    return parsed.key && parsed.direction ? parsed : DEFAULT_SORT
  } catch {
    return DEFAULT_SORT
  }
}

/** The folders to re-scan for "Refresh all": every scan root, minus any inside another. */
function refreshRoots(entries: Iterable<LibraryEntry>): string[] {
  const roots = new Set<string>()
  for (const entry of entries) roots.add(entry.scanRoot ?? entry.path)
  const sorted = [...roots].sort((a, b) => a.length - b.length)
  const kept: string[] = []
  for (const root of sorted) if (!kept.some((outer) => isWithin(root, outer))) kept.push(root)
  return kept
}

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('library')
  const [settings, setSettings] = useState<AppSettings>()
  // Per-file and per-folder mode overrides, kept in the main process.
  const [overrides, setOverrides] = useState<ModeOverrides>({})
  const [environment, setEnvironment] = useState<EnvironmentInfo>()
  const [about, setAbout] = useState<AboutInfo>()
  const [aboutOpen, setAboutOpen] = useState(false)
  const [whatsNew, setWhatsNew] = useState<ReleaseNote[]>([])
  const [browsingRemote, setBrowsingRemote] = useState(false)
  // Every file ever scanned, by path; mirrored to IndexedDB.
  const [library, setLibrary] = useState<Map<string, LibraryEntry>>(new Map())
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [scanErrors, setScanErrors] = useState<ScanError[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** The row whose details are open in the panel beside the list. */
  const [openPath, setOpenPath] = useState<string>()
  /**
   * Where one file's repair goes, when that is not what Settings says.
   *
   * Kept here rather than in the settings file because it belongs to a path
   * that may not exist tomorrow: a destination set on a file that has since
   * been moved or repaired is not worth carrying forward, and the settings
   * file is not the place to accumulate dead paths.
   */
  const [outputOverrides, setOutputOverrides] = useState<Record<string, OutputOverride>>(() => readOutputOverrides())
  const outputOverridesRef = useRef(outputOverrides)
  outputOverridesRef.current = outputOverrides
  // The paths a bulk metadata lookup is open for; undefined when it is not.
  const [lookingUp, setLookingUp] = useState<string[] | undefined>()
  const [facets, setFacets] = useState<Set<ResultFacet>>(new Set())
  const [codecs, setCodecs] = useState<CodecFilter>(emptyCodecFilter)
  const [status, setStatus] = useState<FileStatus>()
  const [hidePassed, setHidePassed] = useState(() => readPref('hidePassed'))
  const [sort, setSort] = useState<SortState>(readSort)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<{ processed: number; total: number; currentPath?: string }>()
  const [jobs, setJobs] = useState<Job[]>([])
  const [dragging, setDragging] = useState(false)
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  const [removingBackups, setRemovingBackups] = useState(false)
  // Leftover repair temporaries the last scan removed, for a line of feedback.
  const [cleaned, setCleaned] = useState<{ path: string; bytes: number }[]>([])
  /**
   * The repair waiting to be confirmed, with everything needed to start it.
   *
   * Held rather than recomputed when the dialog answers: the files were probed
   * and counted as they are now, and re-deriving them on Start would let the
   * table change underneath the question that was answered.
   */
  const [confirming, setConfirming] = useState<{
    requests: RepairRequest[]
    summary: RepairSummary
    mode?: RepairMode
    mayRename: boolean
    /** A destination already set on the file, which the dialog starts from. */
    output?: OutputOverride
  }>()

  const scanIdRef = useRef<string | undefined>(undefined)
  // Read by the scan-complete listener, registered once.
  const libraryRef = useRef(library)
  libraryRef.current = library
  // Read inside `repair`, which is created once so the rows keep their handler.
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Read inside `refreshFile`, which must not re-create itself on every job
  // update or every row would lose its handler mid-repair.
  const jobsByPathRef = useRef<Map<string, Job>>(new Map())
  // Read inside `repair`, created once, to say what a bulk repair will do.
  const resultsByPathRef = useRef<Map<string, AnalysisResult>>(new Map())

  // The About menu item, which the main process routes here rather than to
  // the native panel — that one can show a version and nothing else.
  useEffect(() => window.plexfixer.app.onShowAbout(() => setAboutOpen(true)), [])

  /* --- bootstrap ------------------------------------------------------ */

  useEffect(() => {
    void (async () => {
      const [loadedSettings, loadedOverrides, loadedAbout, entries] = await Promise.all([
        window.plexfixer.settings.get(),
        window.plexfixer.overrides.get(),
        window.plexfixer.app.about(),
        loadLibrary().catch((error: unknown) => {
          console.error('Could not open the library database', error)
          return [] as LibraryEntry[]
        })
      ])
      console.info(`Loaded ${entries.length} file${entries.length === 1 ? '' : 's'} from the library`)
      setSettings(loadedSettings)
      setOverrides(loadedOverrides)
      // Held from startup rather than fetched when the panel opens: the
      // version belongs in every diagnostic report too.
      setAbout(loadedAbout)
      // The release notes, once per version. The version is recorded as soon
      // as it has been worked out rather than when the dialog closes: a quit
      // before reading them is still having been shown them, and the same
      // notes opening again every launch would be worse than missing them.
      setWhatsNew(notesSince(readText('lastSeenVersion'), loadedAbout.version))
      writeText('lastSeenVersion', loadedAbout.version)
      // Merged rather than replaced: a scan started from the command line may
      // already have streamed fresher entries in while the database opened.
      setLibrary((previous) => {
        const next = new Map(entries.map((entry) => [entry.path, entry]))
        for (const [path, entry] of previous) next.set(path, entry)
        return next
      })
      setLibraryLoaded(true)
      // Capability detection runs test encodes, so it lands after the UI.
      setEnvironment(await window.plexfixer.environment.get())
    })()
  }, [])

  useEffect(() => {
    // Scanned files stream in one progress event each. They are batched for a
    // moment before reaching the table and IndexedDB: with several probes in
    // flight, re-sorting a large library on every file would be wasted work,
    // and a quarter-second batch still reads as live.
    let pending: LibraryEntry[] = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    /** Merge the buffered entries, and delete `remove`, in state and in one IDB transaction. */
    const flush = (remove: string[] = []): void => {
      clearTimeout(flushTimer)
      flushTimer = undefined
      const put = pending
      pending = []
      if (put.length === 0 && remove.length === 0) return
      setLibrary((previous) => {
        const next = new Map(previous)
        for (const path of remove) next.delete(path)
        for (const entry of put) next.set(entry.path, entry)
        return next
      })
      void writeLibrary(put, remove).catch((error: unknown) => console.error('Could not save the scan', error))
    }

    const offProgress = window.plexfixer.scan.onProgress((event) => {
      if (event.scanId !== scanIdRef.current) return
      if (event.result) {
        pending.push(entryFromResult(event.result))
        flushTimer ??= setTimeout(() => flush(), 250)
      }
      setScanProgress({ processed: event.processed, total: event.total, currentPath: event.currentPath })
    })
    const offComplete = window.plexfixer.scan.onComplete((event) => {
      if (event.scanId !== scanIdRef.current) return
      // Files a completed scan no longer finds under its folders are dropped.
      // `libraryRef` may not yet hold the latest streamed entries, but those
      // were all found by this scan, so they could never be stale anyway.
      const remove = stalePaths(libraryRef.current.keys(), event.inputPaths, event.foundPaths, event.cancelled)
      flush(remove)
      setSelected((previous) => {
        const next = new Set(previous)
        for (const path of remove) next.delete(path)
        return next
      })
      setScanErrors(event.errors)
      setCleaned(event.cleaned ?? [])
      setScanning(false)
      setScanProgress(undefined)
    })
    const offJob = window.plexfixer.jobs.onUpdate((job) => {
      setJobs((previous) => {
        const index = previous.findIndex((entry) => entry.id === job.id)
        if (index < 0) return [...previous, job]
        const next = [...previous]
        next[index] = job
        return next
      })
    })
    return () => {
      flush()
      offProgress()
      offComplete()
      offJob()
    }
  }, [])

  /* --- actions --------------------------------------------------------- */

  /**
   * Start a scan.
   *
   * Asking for a new folder clears the filters first. They belong to the view
   * the user was just looking at, and leaving a status tile or a chip on means
   * the files they asked to see arrive into a list that is hiding them — which
   * reads as the scan having done nothing. Re-scanning what is already in the
   * library is the opposite case: that is a refresh of the current view, so it
   * keeps them.
   */
  const startScan = useCallback(async (paths: string[], keepFilters = false) => {
    if (paths.length === 0) return
    if (!keepFilters) {
      setStatus(undefined)
      setFacets(new Set())
      setQuery('')
    }
    // The id is generated here and recorded synchronously, so events for this
    // scan are never discarded because the await had not resolved yet.
    const scanId = crypto.randomUUID()
    scanIdRef.current = scanId
    setScanning(true)
    setScanErrors([])
    setScanProgress({ processed: 0, total: 0 })
    setTab('library')
    await window.plexfixer.scan.start(paths, scanId)
  }, [])

  /**
   * Forget every scanned file.
   *
   * The filters go with the rows they were narrowing: leaving a status tile or
   * a chip on an empty library would make the next scan arrive into a list
   * that is already hiding it. Nothing on disk is touched — this empties
   * PlexFixer's record of what it has looked at, and a fresh scan rebuilds it.
   */
  const clearLibrary = useCallback(async () => {
    setLibrary(new Map())
    setSelected(new Set())
    setStatus(undefined)
    setFacets(new Set())
    setQuery('')
    setScanErrors([])
    await clearStoredLibrary().catch((error: unknown) =>
      console.error('Could not clear the library', error)
    )
  }, [])

  // Scan anything the app was launched with, and anything opened later from
  // Finder or a second launch.
  useEffect(() => {
    void (async () => {
      const paths = await window.plexfixer.app.initialPaths()
      if (paths.length > 0) await startScan(paths)
    })()
    return window.plexfixer.app.onOpenPaths((paths) => void startScan(paths))
  }, [startScan])

  /**
   * Open a picker and scan what comes back.
   *
   * `kind` is here because the native dialog cannot do both at once: a file
   * picker will not let a folder be chosen, and a folder picker will not let a
   * file be chosen. Two ways in is the price of that, and the folder is the
   * one that leads, since a library is the ordinary thing to point this at.
   */
  const choosePaths = useCallback(
    async (kind: 'files' | 'folders') => {
      // The native dialog can only see this machine, so remote mode gets its own
      // browser — picking a local folder while the work runs elsewhere would
      // scan a path that does not exist there. That browser does both, so there
      // is nothing for `kind` to choose between.
      if (settingsRef.current?.remoteEnabled) {
        setBrowsingRemote(true)
        return
      }
      const paths =
        kind === 'folders'
          ? await window.plexfixer.dialog.pickFolders()
          : await window.plexfixer.dialog.pickPaths()
      await startScan(paths)
    },
    [startScan]
  )

  const cancelScan = useCallback(async () => {
    if (scanIdRef.current) await window.plexfixer.scan.cancel(scanIdRef.current)
    setScanning(false)
    setScanProgress(undefined)
  }, [])

  /** Set, or with `null` clear, the override on one file or folder. */
  const setMode = useCallback(async (path: string, mode: RepairMode | null) => {
    setOverrides(await window.plexfixer.overrides.set(path, mode))
  }, [])

  /**
   * Re-probe what will run the work, once the setting has settled.
   *
   * A refresh is an ssh round trip to the remote host and a set of test
   * encodes locally. A toggle is one deliberate change and can have it at
   * once; a text field produces one change per keystroke, and probing a
   * half-typed hostname only produces a slow failure, so those wait until the
   * typing stops.
   */
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const refreshEnvironment = useCallback((delay: number) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => {
      void (async () => setEnvironment(await window.plexfixer.environment.refresh()))()
    }, delay)
  }, [])

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      // Verdicts are recomputed from the stored probes against the new settings
      // (see `results`), so nothing needs re-scanning.
      setSettings(await window.plexfixer.settings.update(patch))
      // Anything that changes *which* ffmpeg runs, or where, means the
      // environment on screen is about to be wrong.
      const typedKeys = [
        'ffmpegPath',
        'ffprobePath',
        'remoteHost',
        'remotePort',
        'remoteFfmpegPath',
        'remoteFfprobePath'
      ] as const
      if ('remoteEnabled' in patch) refreshEnvironment(0)
      else if (typedKeys.some((key) => key in patch)) refreshEnvironment(600)
    },
    [refreshEnvironment]
  )

  /**
   * Re-analyse a single row in place.
   *
   * An in-place repair that changes container renames the file, so when the
   * original path is gone we follow the finished job to the new one and the row
   * tracks the repaired file rather than disappearing.
   */
  /** Where a finished repair of `path` actually wrote its file, if it finished. */
  const finishedOutputFor = useCallback((path: string): string | undefined => {
    const job = jobsByPathRef.current.get(path)
    return job?.state === 'done' ? job.outputPath : undefined
  }, [])

  const refreshFile = useCallback(
    async (path: string) => {
      setRefreshing((previous) => new Set(previous).add(path))
      try {
        let targetPath = path
        let response = await window.plexfixer.scan.rescanFile(path)

        if (response.missing) {
          const moved = finishedOutputFor(path)
          if (moved && moved !== path) {
            targetPath = moved
            response = await window.plexfixer.scan.rescanFile(moved)
          }
        }

        if (response.result) {
          // A re-probe takes a moment, and nothing stops the list being
          // cleared meanwhile: Clear list is live during a refresh, which does
          // not set `scanning`. Writing the row back then would undo the clear
          // in the table and in IndexedDB, so a file the library no longer
          // holds is dropped rather than re-added.
          if (!libraryRef.current.has(path)) return
          const scanRoot = libraryRef.current.get(path)?.scanRoot
          const entries = [entryFromResult(response.result, scanRoot)]
          const remove = targetPath !== path ? [path] : []

          // A repair set to write beside the original, or into an output
          // folder, leaves the source exactly as it was: re-scanning it finds
          // the same faults, and the row rightly keeps saying so. The repaired
          // file is a different file, and nothing had ever put it in the
          // library — so the fix the user just ran was nowhere on screen, and
          // the row's "done" badge sat next to a status that had not budged.
          const output = finishedOutputFor(path)
          if (output && output !== targetPath) {
            const made = await window.plexfixer.scan.rescanFile(output)
            if (made.result) entries.push(entryFromResult(made.result, scanRoot))
          }

          setLibrary((previous) => {
            const next = new Map(previous)
            for (const gone of remove) next.delete(gone)
            for (const added of entries) next.set(added.path, added)
            return next
          })
          void writeLibrary(entries, remove).catch((error: unknown) => console.error('Could not save the scan', error))
          if (targetPath !== path) {
            setSelected((previous) => {
              if (!previous.has(path)) return previous
              const next = new Set(previous)
              next.delete(path)
              next.add(targetPath)
              return next
            })
          }
          setScanErrors((previous) => previous.filter((entry) => entry.path !== path))
          return
        }

        if (response.missing) {
          setLibrary((previous) => {
            const next = new Map(previous)
            next.delete(path)
            return next
          })
          void writeLibrary([], [path]).catch((error: unknown) => console.error('Could not save the scan', error))
          setSelected((previous) => {
            const next = new Set(previous)
            next.delete(path)
            return next
          })
          return
        }

        if (response.error) {
          const message = response.error
          setScanErrors((previous) => [...previous.filter((entry) => entry.path !== path), { path, message }])
        }
      } finally {
        setRefreshing((previous) => {
          const next = new Set(previous)
          next.delete(path)
          return next
        })
      }
    },
    // `finishedOutputFor` reads a ref and never changes, so this stays the one
    // handler every row keeps hold of for the life of the app.
    [finishedOutputFor]
  )

  /**
   * Re-analyse just the chosen files, a few at a time. Goes through the same
   * per-row refresh rather than a scan, which would reset each file's scan root
   * to its own folder and lose the folder it was originally found under.
   */
  const refreshSelected = useCallback(
    async (paths: string[]) => {
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < paths.length) await refreshFile(paths[cursor++])
      }
      await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker))
    },
    [refreshFile]
  )

  /** Re-scan every folder in the library. */
  const refreshAll = useCallback(async () => {
    await startScan(refreshRoots(libraryRef.current.values()), true)
  }, [startScan])

  /**
   * Queue repairs. The stored probe goes along with each path; the main process
   * re-probes any file that has changed on disk since it was scanned.
   *
   * `mode` forces one mode on the whole batch. Left out, each file uses its own
   * mode — its override, its folder's, or the global default — which is what
   * the per-folder settings are for.
   *
   * A batch that would re-encode video asks first, saying how many files are
   * re-encoded and how many only remuxed: a re-encode takes hours across a
   * library and is not undone by a click.
   */
  const repair = useCallback(
    async (paths: string[], mode?: RepairMode) => {
      const requests = paths.flatMap((path) => {
        const entry = libraryRef.current.get(path)
        return entry ? [{ file: entry.file, scanRoot: entry.scanRoot }] : []
      })
      if (requests.length === 0) return
      // Say what each file will actually get: Force transcode only re-encodes
      // the files that need it, and the rest are remuxed as usual.
      const analysed = requests.flatMap((request) => {
        const result = resultsByPathRef.current.get(request.file.path)
        return result ? [result] : []
      })
      const summary = summarizeRepair(
        analysed,
        overridesRef.current,
        settingsRef.current?.defaultMode ?? 'safe-remux',
        mode
      )
      const settings = settingsRef.current
      const mayRename =
        (settings?.movieTemplate.trim() ?? '') !== '' || (settings?.episodeTemplate.trim() ?? '') !== ''
      // Anything that re-encodes asks first — one file included, which used to
      // start hours of work from a single click — and the question it asks is
      // where the result goes, not only whether to go ahead.
      // A destination set on a file applies to repairs of that file. Only for
      // one at a time: a selection of twenty with four different destinations
      // is one job queue that cannot honour all of them, and quietly picking
      // one would be worse than ignoring them all.
      const output = requests.length === 1 ? outputOverridesRef.current[requests[0].file.path] : undefined

      if (summary.reencode > 0) {
        setConfirming({ requests, summary, mode, mayRename, output })
        return
      }
      await startRepair(requests, mode, output)
    },
    []
  )

  /**
   * Queue a repair that has been asked about, or needed no asking.
   *
   * `output` is this run's destination when it is not the standing one; it is
   * handed straight to the bridge, which puts it in the settings those jobs
   * are queued with and nowhere else.
   */
  const startRepair = useCallback(
    async (requests: RepairRequest[], mode?: RepairMode, output?: OutputOverride) => {
      // Switched before the files are queued, not after. Each one is re-probed
      // on its way in, so a large batch takes a while to arrive — and watching
      // it arrive, with Cancel all in reach, beats staring at the library.
      setTab('jobs')
      await window.plexfixer.jobs.enqueue(requests, mode, output)
    },
    []
  )

  /**
   * Write metadata somebody set by hand.
   *
   * Queued as a safe remux rather than in the file's own mode: this was asked
   * for outright, and a file sitting in Report only is not a reason to drop an
   * instruction on the floor. The dialog has already shown what it will do.
   */
  const applyMetadata = useCallback(async (path: string, edits: MetadataEdit) => {
    const entry = libraryRef.current.get(path)
    if (!entry) return
    setTab('jobs')
    await window.plexfixer.jobs.enqueue([{ file: entry.file, scanRoot: entry.scanRoot, edits }], 'safe-remux')
  }, [])

  /** The same thing for a whole selection, queued in one go. */
  const applyMetadataMany = useCallback(async (edits: { path: string; edit: MetadataEdit }[]) => {
    const items = edits.flatMap(({ path, edit }) => {
      const entry = libraryRef.current.get(path)
      return entry ? [{ file: entry.file, scanRoot: entry.scanRoot, edits: edit }] : []
    })
    if (items.length === 0) return
    setTab('jobs')
    await window.plexfixer.jobs.enqueue(items, 'safe-remux')
  }, [])

  /* --- drag and drop ---------------------------------------------------- */

  /**
   * Paths dropped on the window.
   *
   * The drop itself is handled natively — the page never sees a `drop` event
   * carrying files — so the paths arrive through the same channel as the ones
   * given on the command line.
   */
  const onDroppedPaths = useCallback(
    async (paths: string[]) => {
      setDragging(false)
      // A dropped file is a path on this machine; in remote mode that path
      // means nothing on the far end, and scanning it would fail file by file.
      if (settingsRef.current?.remoteEnabled) {
        setScanErrors(
          paths.slice(0, 5).map((path) => ({
            path,
            message:
              'Dropped files are on this machine. Remote mode scans the remote host — use Add folder… to browse it.'
          }))
        )
        return
      }
      await startScan(paths)
    },
    [startScan]
  )

  // The highlight under a dragged file, and the drop itself.
  useEffect(() => window.plexfixer.app.onDragState(setDragging), [])
  useEffect(() => window.plexfixer.app.onDroppedPaths((paths) => void onDroppedPaths(paths)), [onDroppedPaths])

  /* --- derived ---------------------------------------------------------- */

  const jobsByPath = useMemo(() => {
    const map = new Map<string, Job>()
    // Later jobs for the same file supersede earlier ones.
    for (const job of jobs) map.set(job.sourcePath, job)
    return map
  }, [jobs])

  useEffect(() => {
    jobsByPathRef.current = jobsByPath
  }, [jobsByPath])

  // Sorted by path so the table is stable across scans and restarts.
  const results = useMemo(() => {
    if (!settings) return []
    return [...library.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => analyzeEntry(entry, settings))
  }, [library, settings])

  const counts = useMemo(() => countStatuses(results), [results])

  // The folders the library was built from, for the folder-level suggestion.
  const libraryRoots = useMemo(() => refreshRoots(library.values()), [library])

  const resultsByPath = useMemo(() => {
    const map = new Map<string, AnalysisResult>()
    for (const entry of results) map.set(entry.file.path, entry)
    return map
  }, [results])

  useEffect(() => {
    resultsByPathRef.current = resultsByPath
  }, [resultsByPath])

  /*
   * The row the panel is showing.
   *
   * Read from the map rather than held in state, so a re-scan of that file
   * updates the panel instead of leaving it showing what the file used to be.
   *
   * It is also *sticky*: while a path is open, a render where the map has no
   * entry for it keeps showing the last one. A re-scan rebuilds the map, and
   * for the render where the entry is briefly absent the panel would otherwise
   * unmount — taking with it any dialog open inside it, and everything typed
   * into it. Losing a half-finished edit to a background refresh is not a
   * trade worth making for a panel that empties a few milliseconds sooner.
   */
  const lastOpen = useRef<AnalysisResult>(undefined)
  const openResult = useMemo(() => {
    if (!openPath) {
      lastOpen.current = undefined
      return undefined
    }
    const found = resultsByPath.get(openPath)
    if (found) lastOpen.current = found
    else if (lastOpen.current?.file.path !== openPath) lastOpen.current = undefined
    return found ?? lastOpen.current
  }, [openPath, resultsByPath])

  // The search narrows first, so the chips count what the search left.
  const searched = useMemo(
    () => (query.trim() ? results.filter((entry) => matchesSearch(entry.file.path, query)) : results),
    [results, query]
  )
  // Then the status tile, then "Hide passed". Picking the Passed tile is an
  // explicit ask to see passed files, so it overrides the toggle.
  const hidingPassed = hidePassed && status !== 'passed'
  const narrowed = useMemo(() => {
    let rows = searched
    if (status) rows = rows.filter((entry) => matchesStatus(entry, status))
    if (hidingPassed) rows = rows.filter((entry) => fileStatus(entry) !== 'passed')
    return rows
  }, [searched, status, hidingPassed])
  // Then the codec pickers, then the work chips, whose counts reflect the codecs.
  const codecCounts = useMemo(() => countCodecs(narrowed, codecs), [narrowed, codecs])
  const codecFiltered = useMemo(() => filterByCodec(narrowed, codecs), [narrowed, codecs])
  const facetCounts = useMemo(() => countFacets(codecFiltered), [codecFiltered])
  // Sorted last, so the filters above decide *which* rows and this decides
  // only their order.
  const visibleResults = useMemo(
    () => sortResults(filterResults(codecFiltered, facets), sort),
    [codecFiltered, facets, sort]
  )

  // A selected file that is re-scanned or repaired into something the filters
  // hide leaves the selection. Changing the filters themselves does not.
  const previousLibraryRef = useRef(library)
  useEffect(() => {
    const before = previousLibraryRef.current
    previousLibraryRef.current = library
    if (before === library) return
    const visible = new Set(visibleResults.map((entry) => entry.file.path))
    setSelected((previous) => pruneSelection(previous, before, library, visible))
  }, [library, visibleResults])

  if (!settings || !libraryLoaded) {
    return (
      <div className="app">
        <div className="titlebar">PlexFixer</div>
        <div className="content">
          <div className="empty">Loading…</div>
        </div>
      </div>
    )
  }

  const selectedPaths = [...selected].filter((path) => library.has(path))
  const chipFiltersActive = facets.size > 0 || codecFilterActive(codecs)

  return (
    <div
      className="app"

    >
      <div className="titlebar">
        PlexFixer
        <button
          className="ghost titlebar-about"
          onClick={() => setAboutOpen(true)}
          title="Version details"
          aria-label="About PlexFixer"
        >
          About
        </button>
      </div>

      <div className="toolbar">
        <div className="tabs">
          <button aria-selected={tab === 'library'} onClick={() => setTab('library')}>
            Library
          </button>
          <button aria-selected={tab === 'jobs'} onClick={() => setTab('jobs')}>
            Queue{jobs.filter((job) => job.state === 'running' || job.state === 'queued').length > 0 ? ` (${jobs.filter((job) => job.state === 'running' || job.state === 'queued').length})` : ''}
          </button>
          <button aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>
            Settings
          </button>
        </div>

        {environment?.remote ? (
          <span
            className={`badge ${environment.ready ? 'info' : 'fail'}`}
            title={
              environment.ready
                ? `Scans and repairs run on ${environment.remote.host}${environment.remote.platform ? ` (${environment.remote.platform})` : ''}`
                : (environment.problem ?? 'The remote host is not usable')
            }
          >
            {environment.remote.host}
          </span>
        ) : null}

        <span className="spacer" />

        {tab === 'library' ? (
          <>
            {results.length > 0 ? (
              <>
                <span className="muted nowrap selection-count">{selectedPaths.length} selected</span>
                <button
                  onClick={() => setSelected(new Set())}
                  disabled={selected.size === 0}
                  title="Unselect every file, including any a filter is hiding"
                >
                  Clear selection
                </button>
                <MenuButton
                  label="Bulk"
                  title="Actions for the selected files"
                  disabledTitle="Select files to act on them"
                  disabled={selectedPaths.length === 0}
                  items={[
                    {
                      key: 'rescan',
                      label: refreshing.size > 0 ? 'Rescanning…' : 'Rescan',
                      hint: 'Re-scan only the selected files',
                      disabled: scanning || refreshing.size > 0,
                      onSelect: () => void refreshSelected(selectedPaths)
                    },
                    {
                      key: 'repair',
                      label: 'Repair',
                      hint: "Each file in its own mode — its override, its folder's, or the default",
                      onSelect: () => void repair(selectedPaths)
                    },
                    {
                      key: 'remux',
                      label: 'Force lossless remux',
                      hint: 'Only the lossless fixes; files that need a re-encode are skipped',
                      onSelect: () => void repair(selectedPaths, 'safe-remux')
                    },
                    {
                      key: 'transcode',
                      label: 'Force transcode',
                      hint: 'Fix everything, re-encoding video only where a remux cannot',
                      onSelect: () => void repair(selectedPaths, 'force-transcode')
                    },
                    {
                      key: 'metadata',
                      label: 'Metadata lookup',
                      hint: 'Search themoviedb.org for each file and review the answers before writing',
                      disabled: !settings || settings.tmdbCredential.trim() === '',
                      disabledHint: 'Add your themoviedb.org key under Settings → Metadata first',
                      onSelect: () => setLookingUp(selectedPaths)
                    }
                  ]}
                />
              </>
            ) : null}
            {scanning ? (
              <button onClick={() => void cancelScan()}>Cancel scan</button>
            ) : (
              <>
                <button
                  onClick={() => void refreshAll()}
                  disabled={library.size === 0}
                  title="Re-scan every folder in the library"
                >
                  Refresh all
                </button>
                <button
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Remove all ${library.size} file${library.size === 1 ? '' : 's'} from the list?\n\n` +
                          'This clears only what PlexFixer has scanned. Your media files are not touched.'
                      )
                    ) {
                      return
                    }
                    void clearLibrary()
                  }}
                  disabled={library.size === 0}
                  title="Forget every scanned file. Your media files are not touched."
                >
                  Clear list
                </button>
                <button
                  onClick={() => void choosePaths('files')}
                  title="Choose one or more media files."
                >
                  Add files…
                </button>
                <button
                  className="primary"
                  onClick={() => void choosePaths('folders')}
                  title="Choose a folder. Everything beneath it is scanned."
                >
                  Add folder…
                </button>
              </>
            )}
          </>
        ) : null}
      </div>

      {/*
        The library keeps a header of its own: the tiles, the search box and the
        filter chips stay put while only the file list scrolls. The queue does
        the same with its toolbar. Every other tab scrolls as one page.
      */}
      <div className={`content${tab === 'library' || tab === 'jobs' ? ' split' : ''}`}>
        {environment && !environment.ready ? (
          <div className="banner error">
            <strong>FFmpeg not available.</strong> {environment.problem}
          </div>
        ) : null}

        {tab === 'library' ? (
          <div className="library">
            <div className="library-head">
              {scanning ? (
                <div className="banner">
                  <strong>
                    Scanning… {scanProgress?.processed ?? 0}
                    {scanProgress?.total ? ` of ${scanProgress.total}` : ''}
                  </strong>
                  {scanProgress?.currentPath ? <div className="muted mono">{scanProgress.currentPath}</div> : null}
                </div>
              ) : null}

              {cleaned.length > 0 ? (
                <div className="banner">
                  <strong>
                    Removed {cleaned.length} leftover temporary file{cleaned.length === 1 ? '' : 's'} (
                    {formatBytes(cleaned.reduce((total, entry) => total + entry.bytes, 0))}).
                  </strong>{' '}
                  {cleaned.length === 1 ? 'It was' : 'They were'} left by a repair that never finished.
                  <button className="ghost" style={{ marginLeft: 8 }} onClick={() => setCleaned([])}>
                    Dismiss
                  </button>
                </div>
              ) : null}

              {scanErrors.length > 0 ? (
                <div className="banner error">
                  <strong>
                    {scanErrors.length} file{scanErrors.length === 1 ? '' : 's'} could not be read.
                  </strong>
                  {scanErrors.slice(0, 5).map((error) => (
                    <div key={error.path} className="muted mono" style={{ fontSize: 11 }}>
                      {error.path} — {error.message}
                    </div>
                  ))}
                </div>
              ) : null}

              {results.length > 0 ? (
                <>
                  <div className="library-bar">
                    <div className="summary">
                      {STATUS_TILES.map((tile) => {
                        const on = status === tile.key
                        return (
                          <button
                            key={tile.key}
                            className={`stat ${tile.tone}${counts[tile.key] === 0 ? ' quiet' : ''}`}
                            aria-pressed={on}
                            title={on ? 'Show all files again' : tile.hint}
                            onClick={() => setStatus(on ? undefined : tile.key)}
                          >
                            <span className="value">{counts[tile.key]}</span>
                            <span className="label">
                              {tile.label}
                              {on ? <span className="clear-mark"> ×</span> : null}
                            </span>
                          </button>
                        )
                      })}
                    </div>

                    <span className="spacer" />

                    <SearchBox
                      value={query}
                      onChange={setQuery}
                      summary={
                        visibleResults.length === results.length
                          ? undefined
                          : `${visibleResults.length} of ${results.length}`
                      }
                    />

                    <HidePassed
                      on={hidingPassed}
                      count={counts.passed}
                      onChange={(hide) => {
                        setHidePassed(hide)
                        writePref('hidePassed', hide)
                        // Hiding passed files while the Passed tile is showing
                        // only them is a contradiction. The switch is the later
                        // instruction, so the tile gives way.
                        if (hide && status === 'passed') setStatus(undefined)
                      }}
                    />

                    <FilterMenu
                      counts={facetCounts}
                      active={facets}
                      codecCounts={codecCounts}
                      codecs={codecs}
                      onToggle={(facet) =>
                        setFacets((previous) => {
                          const next = new Set(previous)
                          if (next.has(facet)) next.delete(facet)
                          else next.add(facet)
                          return next
                        })
                      }
                      onToggleCodec={(kind, codec) =>
                        setCodecs((previous) => {
                          const next = new Set(previous[kind])
                          if (next.has(codec)) next.delete(codec)
                          else next.add(codec)
                          return { ...previous, [kind]: next }
                        })
                      }
                      onClear={() => {
                        setFacets(new Set())
                        setCodecs({ video: new Set(), audio: new Set() })
                      }}
                    />
                  </div>


                </>
              ) : null}
            </div>

            <div className={`library-body${openResult ? ' with-panel' : ''}`}>
              {results.length === 0 && !scanning ? (
                <div className={`dropzone${dragging ? ' active' : ''}`}>
                  <h2>Drop media files or a folder here</h2>
                  <p>
                    PlexFixer checks whether each MKV or M4V will direct play on a remote Plex client, and fixes what it
                    can without re-encoding.
                  </p>
                  <div className="dropzone-actions">
                    <button
                      onClick={() => void choosePaths('files')}
                      title="Choose one or more media files."
                    >
                      Add files…
                    </button>
                    <button
                      className="primary"
                      onClick={() => void choosePaths('folders')}
                      title="Choose a folder. Everything beneath it is scanned."
                    >
                      Add folder…
                    </button>
                  </div>
                </div>
              ) : null}

              {results.length > 0 ? (
                <>
                  {visibleResults.length === 0 ? (
                    <div className="empty">
                      {query.trim() && searched.length === 0
                        ? `No file matches “${query.trim()}”.`
                        : hidingPassed && !status && !chipFiltersActive
                          ? 'Every file here passed. Turn off Hide passed to see them.'
                          : 'No file matches the filters you have on. Clear one to see the rest.'}
                    </div>
                  ) : null}

                  <ResultsTable
                    sort={sort}
                    onSort={(key) =>
                      setSort((previous) => {
                        const next = nextSort(previous, key)
                        try {
                          localStorage.setItem('plexfixer.sort', JSON.stringify(next))
                        } catch {
                          /* a sort that is not remembered is not worth an error */
                        }
                        return next
                      })
                    }
                    appVersion={about?.version}
                    results={visibleResults}
                    jobs={jobsByPath}
                    selected={selected}
                    onToggleSelect={(path) =>
                      setSelected((previous) => {
                        const next = new Set(previous)
                        if (next.has(path)) next.delete(path)
                        else next.add(path)
                        return next
                      })
                    }
                    onToggleAll={() =>
                      setSelected((previous) => {
                        // Acts on the rows actually on screen: selecting files a
                        // filter is hiding is not what the header checkbox means.
                        const visible = visibleResults.map((r) => r.file.path)
                        const next = new Set(previous)
                        if (visible.every((path) => next.has(path))) for (const path of visible) next.delete(path)
                        else for (const path of visible) next.add(path)
                        return next
                      })
                    }
                    overrides={overrides}
                    defaultMode={settings.defaultMode}
                    settings={settings}
                    environment={environment}
                    onSetMode={(path, mode) => void setMode(path, mode)}
                    onRepair={(paths, mode) => void repair(paths, mode)}
                    onApplyMetadata={(path, edits) => void applyMetadata(path, edits)}
                    onSubtitleWritten={(path) => {
                      // The track list is part of the probe, so the row is
                      // re-read rather than patched: the new file is beside the
                      // film and the row should say so.
                      const film = path.replace(/\.[^.]*\.srt$/, '')
                      const row = results.find((entry) => entry.file.path.startsWith(film))
                      if (row) void refreshFile(row.file.path)
                    }}
                    onReveal={(path) => void window.plexfixer.shell.reveal(path)}
                    onContextMenu={(path) => void window.plexfixer.shell.fileMenu(path)}
                    onRefresh={(path) => void refreshFile(path)}
                    onLookUp={(path) => setLookingUp([path])}
                    lookUpDisabledHint={
                      settings.tmdbCredential.trim() === ''
                        ? 'Add your themoviedb.org key under Settings → Metadata first'
                        : undefined
                    }
                    refreshing={refreshing}
                    activePath={openPath}
                    onOpen={(path) => setOpenPath((current) => (current === path ? undefined : path))}
                  />
                </>
              ) : null}

              {/*
                The details of whichever row is open, beside the list rather
                than unfolded inside it. A row that grew to four hundred pixels
                pushed every other row off the screen, so comparing the file
                you opened with the one under it meant closing it again.
              */}
              {openResult && settings ? (
                <aside className="detail-panel">
                  <FileDetail
                    result={openResult}
                    job={jobsByPath.get(openResult.file.path)}
                    onReveal={(path) => void window.plexfixer.shell.reveal(path)}
                    mode={resolveMode(openResult.file.path, overrides, settings.defaultMode)}
                    defaultMode={settings.defaultMode}
                    overrides={overrides}
                    onSetMode={(path, mode) => void setMode(path, mode)}
                    settings={settings}
                    environment={environment}
                    appVersion={about?.version}
                    onApplyMetadata={(path, edits) => void applyMetadata(path, edits)}
                    onSubtitleWritten={(path) => void refreshFile(path)}
                    onClose={() => setOpenPath(undefined)}
                    outputOverride={outputOverrides[openResult.file.path]}
                    onSetOutput={(next) =>
                      setOutputOverrides((previous) => {
                        const updated = { ...previous }
                        if (next) updated[openResult.file.path] = next
                        else delete updated[openResult.file.path]
                        try {
                          localStorage.setItem(OUTPUT_OVERRIDES_KEY, JSON.stringify(updated))
                        } catch {
                          /* a destination that is not remembered is not worth an error */
                        }
                        return updated
                      })
                    }
                  />
                </aside>
              ) : null}
            </div>
          </div>
        ) : null}

        {tab === 'jobs' ? (
          <JobsPanel
            jobs={jobs}
            resultsByPath={resultsByPath}
            environment={environment}
            appVersion={about?.version}
            about={about}
            settings={settings}
            libraryCounts={{
              total: results.length,
              passed: counts.passed,
              fixable: counts.fixable,
              reencode: counts.reencode,
              blocked: counts.manual
            }}
            onSave={(name, contents) => window.plexfixer.app.saveText(name, contents)}
            onCancel={(id) => void window.plexfixer.jobs.cancel(id)}
            onCancelAll={() => {
              void (async () => {
                // The runner says which jobs it dropped. Filtering on state
                // here instead would race a job that started in the meantime.
                const dropped = new Set(await window.plexfixer.jobs.cancelAll())
                setJobs((previous) => previous.filter((job) => !dropped.has(job.id)))
              })()
            }}
            onClear={() => {
              void window.plexfixer.jobs.clearFinished()
              setJobs((previous) =>
                previous.filter((job) => job.state === 'queued' || job.state === 'running')
              )
            }}
            onClearQueue={() => {
              void window.plexfixer.jobs.clearQueued()
              // Mirrored here rather than re-fetched: the main process drops
              // the same jobs, and a removal sends no update event.
              setJobs((previous) => previous.filter((job) => job.state !== 'queued'))
            }}
            onReveal={(path) => void window.plexfixer.shell.reveal(path)}
          />
        ) : null}

        {tab === 'settings' ? (
          <SettingsPanel
            settings={settings}
            environment={environment}
            overrides={overrides}
            canRemoveBackups={libraryRoots.length > 0}
            removingBackups={removingBackups}
            onRemoveAllBackups={() => {
              void (async () => {
                setRemovingBackups(true)
                try {
                  const { count, bytes } = await window.plexfixer.backups.summary(libraryRoots)
                  if (count === 0) {
                    window.alert('There are no backups under the scanned folders.')
                    return
                  }
                  const ok = window.confirm(
                    `Remove ${count} backup${count === 1 ? '' : 's'} (${formatBytes(bytes)})?\n\n` +
                      'These are the originals PlexFixer kept when it replaced a file. The repaired files are ' +
                      'not touched. Instant (cloned) backups share their data with the file, so removing them ' +
                      'frees less space than their size suggests.'
                  )
                  if (!ok) return
                  const { removed } = await window.plexfixer.backups.removeAll(libraryRoots)
                  window.alert(`Removed ${removed} backup${removed === 1 ? '' : 's'}.`)
                } catch (error) {
                  window.alert(`Could not remove the backups: ${error instanceof Error ? error.message : String(error)}`)
                } finally {
                  setRemovingBackups(false)
                }
              })()
            }}
            onSetMode={(path, mode) => void setMode(path, mode)}
            onAddFolderOverride={() => {
              void (async () => {
                const directory = await window.plexfixer.dialog.pickDirectory()
                if (directory) await setMode(directory, settings.defaultMode)
              })()
            }}
            onChange={(patch) => void updateSettings(patch)}
            onReset={() => {
              void (async () => {
                setSettings(await window.plexfixer.settings.reset())
                setEnvironment(await window.plexfixer.environment.refresh())
              })()
            }}
            onPickDirectory={() => {
              void (async () => {
                const directory = await window.plexfixer.dialog.pickDirectory()
                if (directory) await updateSettings({ outputDirectory: directory })
              })()
            }}
            onPickBinary={(name) => {
              void (async () => {
                const path = await window.plexfixer.dialog.pickBinary(name)
                if (!path) return
                const field = {
                  ffmpeg: 'ffmpegPath',
                  ffprobe: 'ffprobePath',
                  whisper: 'whisperPath',
                  'whisper-model': 'whisperModelPath'
                } as const
                await updateSettings({ [field[name]]: path })
              })()
            }}
            onRefreshEnvironment={() => {
              void (async () => setEnvironment(await window.plexfixer.environment.refresh()))()
            }}
          />
        ) : null}
      </div>

      {aboutOpen ? (
        <AboutDialog
          about={about}
          environment={environment}
          onClose={() => setAboutOpen(false)}
          // Offered only when this build has notes to show: a button that
          // opens an empty dialog is worse than no button.
          onWhatsNew={
            about && latestNotes(about.version).length > 0
              ? () => {
                  setAboutOpen(false)
                  setWhatsNew(latestNotes(about.version))
                }
              : undefined
          }
        />
      ) : null}

      {whatsNew.length > 0 ? (
        <WhatsNewDialog notes={whatsNew} onClose={() => setWhatsNew([])} />
      ) : null}

      {confirming && settings ? (
        <RepairDialog
          summary={confirming.summary}
          total={confirming.requests.length}
          mode={confirming.mode}
          settings={settings}
          mayRename={confirming.mayRename}
          onClose={() => setConfirming(undefined)}
          onConfirm={(output) => {
            const started = confirming
            setConfirming(undefined)
            void startRepair(started.requests, started.mode, output)
          }}
        />
      ) : null}

      {lookingUp && settings ? (
        <BulkMetadataDialog
          files={lookingUp.flatMap((path) => {
            const entry = library.get(path)
            return entry ? [entry.file] : []
          })}
          settings={settings}
          onClose={() => setLookingUp(undefined)}
          onApply={(edits) => {
            setLookingUp(undefined)
            void applyMetadataMany(edits)
          }}
        />
      ) : null}

      {browsingRemote ? (
        <RemoteBrowser
          host={settings.remoteHost || 'the remote host'}
          defaultPath={settings.remoteDefaultPath}
          onSetDefault={(path) => void updateSettings({ remoteDefaultPath: path })}
          onClose={() => setBrowsingRemote(false)}
          onScan={(paths) => {
            setBrowsingRemote(false)
            void startScan(paths)
          }}
        />
      ) : null}
    </div>
  )
}
