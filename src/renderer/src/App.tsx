import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnalysisResult,
  AppSettings,
  EnvironmentInfo,
  Job,
  RepairMode,
  ScanError
} from '@shared/types.js'
import ResultsTable from './components/ResultsTable.js'
import FilterBar from './components/FilterBar.js'
import type { ResultFacet, StatusFilter } from '@shared/plex/facets.js'
import { countFacets, countStatuses, filterResults, matchesStatus } from '@shared/plex/facets.js'
import JobsPanel from './components/JobsPanel.js'
import SettingsPanel from './components/SettingsPanel.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import {
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
const STATUS_TILES: { key: StatusFilter; label: string; tone?: string; hint: string }[] = [
  { key: 'passed', label: 'Passed', tone: 'ok', hint: 'Show only files that passed every check' },
  { key: 'warnings', label: 'Warnings', tone: 'warn', hint: 'Show only files with warnings' },
  { key: 'blocked', label: 'Blocked', tone: 'fail', hint: 'Show only files that will not direct play as they are' },
  { key: 'lossless', label: 'Lossless fix', hint: 'Show only files a remux can fix without re-encoding' },
  { key: 'reencode', label: 'Need re-encode', hint: 'Show only files that need their video re-encoded' }
]

/**
 * Per-viewer UI preferences. Storage can be unavailable or cleared, so every
 * access is guarded and a missing value just means the default.
 */
function readPref(key: string): boolean {
  try {
    return localStorage.getItem(`plexfixer.${key}`) === 'true'
  } catch {
    return false
  }
}

function writePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(`plexfixer.${key}`, String(value))
  } catch {
    /* not worth surfacing */
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
  const [environment, setEnvironment] = useState<EnvironmentInfo>()
  // Every file ever scanned, by path; mirrored to IndexedDB.
  const [library, setLibrary] = useState<Map<string, LibraryEntry>>(new Map())
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [scanErrors, setScanErrors] = useState<ScanError[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [facets, setFacets] = useState<Set<ResultFacet>>(new Set())
  const [status, setStatus] = useState<StatusFilter>()
  const [hidePassed, setHidePassed] = useState(() => readPref('hidePassed'))
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<{ processed: number; total: number; currentPath?: string }>()
  const [jobs, setJobs] = useState<Job[]>([])
  const [dragging, setDragging] = useState(false)
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())

  const scanIdRef = useRef<string | undefined>(undefined)
  // Read by the scan-complete listener, registered once.
  const libraryRef = useRef(library)
  libraryRef.current = library
  // Read inside `refreshFile`, which must not re-create itself on every job
  // update or every row would lose its handler mid-repair.
  const jobsByPathRef = useRef<Map<string, Job>>(new Map())

  /* --- bootstrap ------------------------------------------------------ */

  useEffect(() => {
    void (async () => {
      const [loadedSettings, entries] = await Promise.all([
        window.plexfixer.settings.get(),
        loadLibrary().catch((error: unknown) => {
          console.error('Could not open the library database', error)
          return [] as LibraryEntry[]
        })
      ])
      console.info(`Loaded ${entries.length} file${entries.length === 1 ? '' : 's'} from the library`)
      setSettings(loadedSettings)
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

  const startScan = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
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

  // Scan anything the app was launched with, and anything opened later from
  // Finder or a second launch.
  useEffect(() => {
    void (async () => {
      const paths = await window.plexfixer.app.initialPaths()
      if (paths.length > 0) await startScan(paths)
    })()
    return window.plexfixer.app.onOpenPaths((paths) => void startScan(paths))
  }, [startScan])

  const choosePaths = useCallback(async () => {
    const paths = await window.plexfixer.dialog.pickPaths()
    await startScan(paths)
  }, [startScan])

  const cancelScan = useCallback(async () => {
    if (scanIdRef.current) await window.plexfixer.scan.cancel(scanIdRef.current)
    setScanning(false)
    setScanProgress(undefined)
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    // Verdicts are recomputed from the stored probes against the new settings
    // (see `results`), so nothing needs re-scanning.
    setSettings(await window.plexfixer.settings.update(patch))
    if ('ffmpegPath' in patch || 'ffprobePath' in patch) {
      setEnvironment(await window.plexfixer.environment.refresh())
    }
  }, [])

  /**
   * Re-analyse a single row in place.
   *
   * An in-place repair that changes container renames the file, so when the
   * original path is gone we follow the finished job to the new one and the row
   * tracks the repaired file rather than disappearing.
   */
  const refreshFile = useCallback(
    async (path: string) => {
      setRefreshing((previous) => new Set(previous).add(path))
      try {
        let targetPath = path
        let response = await window.plexfixer.scan.rescanFile(path)

        if (response.missing) {
          const job = jobsByPathRef.current.get(path)
          const moved = job?.state === 'done' ? job.outputPath : undefined
          if (moved && moved !== path) {
            targetPath = moved
            response = await window.plexfixer.scan.rescanFile(moved)
          }
        }

        if (response.result) {
          const entry = entryFromResult(response.result, libraryRef.current.get(path)?.scanRoot)
          const remove = targetPath !== path ? [path] : []
          setLibrary((previous) => {
            const next = new Map(previous)
            for (const gone of remove) next.delete(gone)
            next.set(entry.path, entry)
            return next
          })
          void writeLibrary([entry], remove).catch((error: unknown) => console.error('Could not save the scan', error))
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
    []
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
    await startScan(refreshRoots(libraryRef.current.values()))
  }, [startScan])

  /**
   * Queue repairs. The stored probe goes along with each path; the main process
   * re-probes any file that has changed on disk since it was scanned.
   *
   * A force transcode of more than one file asks first: it re-encodes video,
   * which takes hours across a library and is not undone by a click.
   */
  const repair = useCallback(async (paths: string[], mode: RepairMode) => {
    const requests = paths.flatMap((path) => {
      const entry = libraryRef.current.get(path)
      return entry ? [{ file: entry.file, scanRoot: entry.scanRoot }] : []
    })
    if (requests.length === 0) return
    if (
      mode === 'force-transcode' &&
      requests.length > 1 &&
      !window.confirm(
        `Force transcode ${requests.length} files? Files that need it will have their video re-encoded.`
      )
    ) {
      return
    }
    await window.plexfixer.jobs.enqueue(requests, mode)
    setTab('jobs')
  }, [])

  /* --- drag and drop ---------------------------------------------------- */

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => window.plexfixer.pathForFile(file))
        .filter(Boolean)
      await startScan(paths)
    },
    [startScan]
  )

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

  const needsTranscode = useMemo(
    () => results.filter((entry) => entry.plan.requiresTranscode).map((entry) => entry.file.path),
    [results]
  )

  const resultsByPath = useMemo(() => {
    const map = new Map<string, AnalysisResult>()
    for (const entry of results) map.set(entry.file.path, entry)
    return map
  }, [results])

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
    if (hidingPassed) rows = rows.filter((entry) => entry.verdict !== 'ok')
    return rows
  }, [searched, status, hidingPassed])
  const facetCounts = useMemo(() => countFacets(narrowed), [narrowed])
  const visibleResults = useMemo(() => filterResults(narrowed, facets), [narrowed, facets])

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

  return (
    <div
      className="app"
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="titlebar">PlexFixer</div>

      <div className="toolbar">
        <div className="tabs">
          <button aria-selected={tab === 'library'} onClick={() => setTab('library')}>
            Library
          </button>
          <button aria-selected={tab === 'jobs'} onClick={() => setTab('jobs')}>
            Jobs{jobs.filter((job) => job.state === 'running' || job.state === 'queued').length > 0 ? ` (${jobs.filter((job) => job.state === 'running' || job.state === 'queued').length})` : ''}
          </button>
          <button aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>
            Settings
          </button>
        </div>

        <span className="spacer" />

        {tab === 'library' ? (
          <>
            {results.length > 0 ? (
              <>
                <span className="muted nowrap">{selectedPaths.length} selected</span>
                <button
                  disabled={selectedPaths.length === 0}
                  onClick={() => void repair(selectedPaths, 'safe-remux')}
                  title="Apply the lossless fixes; files that need a re-encode are skipped"
                >
                  Safe remux selected
                </button>
                <button
                  disabled={selectedPaths.length === 0}
                  onClick={() => void repair(selectedPaths, 'force-transcode')}
                  title="Fix everything, re-encoding video where a remux cannot"
                >
                  Force transcode selected
                </button>
              </>
            ) : null}
            {scanning ? (
              <button onClick={() => void cancelScan()}>Cancel scan</button>
            ) : (
              <>
                {selectedPaths.length > 0 ? (
                  <button
                    onClick={() => void refreshSelected(selectedPaths)}
                    disabled={refreshing.size > 0}
                    title="Re-scan only the selected files"
                  >
                    {refreshing.size > 0 ? 'Refreshing…' : 'Refresh selected'}
                  </button>
                ) : (
                  <button
                    onClick={() => void refreshAll()}
                    disabled={library.size === 0}
                    title="Re-scan every folder in the library"
                  >
                    Refresh all
                  </button>
                )}
                <button className="primary" onClick={() => void choosePaths()}>
                  Scan…
                </button>
              </>
            )}
          </>
        ) : null}
      </div>

      <div className="content">
        {environment && !environment.ready ? (
          <div className="banner error">
            <strong>FFmpeg not available.</strong> {environment.problem}
          </div>
        ) : null}

        {tab === 'library' ? (
          <>
            {scanning ? (
              <div className="banner">
                <strong>
                  Scanning… {scanProgress?.processed ?? 0}
                  {scanProgress?.total ? ` of ${scanProgress.total}` : ''}
                </strong>
                {scanProgress?.currentPath ? <div className="muted mono">{scanProgress.currentPath}</div> : null}
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

            {results.length === 0 && !scanning ? (
              <div className={`dropzone${dragging ? ' active' : ''}`}>
                <h2>Drop media files or a folder here</h2>
                <p>
                  PlexFixer checks whether each MKV or M4V will direct play on a remote Plex client, and fixes what it
                  can without re-encoding.
                </p>
                <button className="primary" onClick={() => void choosePaths()}>
                  Scan…
                </button>
              </div>
            ) : null}

            {results.length > 0 ? (
              <>
                <div className="summary">
                  {STATUS_TILES.map((tile) => {
                    const on = status === tile.key
                    return (
                      <button
                        key={tile.key}
                        className={`stat${tile.tone ? ` ${tile.tone}` : ''}`}
                        aria-pressed={on}
                        title={on ? 'Show all files again' : tile.hint}
                        onClick={() => setStatus(on ? undefined : tile.key)}
                      >
                        <div className="value">{counts[tile.key]}</div>
                        <div className="label">
                          {tile.label}
                          {on ? <span className="clear-mark"> ×</span> : null}
                        </div>
                      </button>
                    )
                  })}
                </div>

                {needsTranscode.length > 0 ? (
                  <div className="banner">
                    <strong>
                      {needsTranscode.length} file{needsTranscode.length === 1 ? '' : 's'} cannot be fixed by a remux
                      alone.
                    </strong>{' '}
                    A safe remux will skip {needsTranscode.length === 1 ? 'it' : 'them'}; Force transcode re-encodes the
                    video.
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button onClick={() => void repair(needsTranscode, 'force-transcode')}>
                        Force transcode {needsTranscode.length === 1 ? 'it' : 'these'} now
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="searchbar">
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search files and folders"
                    aria-label="Search files and folders"
                    spellCheck={false}
                  />
                  {(query.trim() || status || hidingPassed) && facets.size === 0 ? (
                    <span className="muted nowrap">
                      {visibleResults.length} of {results.length}
                    </span>
                  ) : null}
                  <span className="spacer" />
                  <label
                    className={`toggle${hidePassed ? ' on' : ''}`}
                    title={
                      status === 'passed'
                        ? 'The Passed filter is on, so passed files are showing'
                        : 'Leave out files that passed every check'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={hidePassed}
                      disabled={status === 'passed'}
                      onChange={(event) => {
                        setHidePassed(event.target.checked)
                        writePref('hidePassed', event.target.checked)
                      }}
                    />
                    <span className="switch" aria-hidden="true" />
                    Hide passed
                    <span className="count">{counts.passed}</span>
                  </label>
                </div>

                <FilterBar
                  counts={facetCounts}
                  active={facets}
                  total={results.length}
                  shown={visibleResults.length}
                  onToggle={(facet) =>
                    setFacets((previous) => {
                      const next = new Set(previous)
                      if (next.has(facet)) next.delete(facet)
                      else next.add(facet)
                      return next
                    })
                  }
                  onClear={() => setFacets(new Set())}
                />

                {visibleResults.length === 0 ? (
                  <div className="empty">
                    {query.trim() && searched.length === 0
                      ? `No file matches “${query.trim()}”.`
                      : hidingPassed && !status && facets.size === 0
                        ? 'Every file here passed. Turn off Hide passed to see them.'
                        : 'No file matches the filters you have on. Clear one to see the rest.'}
                  </div>
                ) : null}

                <ResultsTable
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
                  onRepair={(paths, mode) => void repair(paths, mode)}
                  onReveal={(path) => void window.plexfixer.shell.reveal(path)}
                  onContextMenu={(path) => void window.plexfixer.shell.fileMenu(path)}
                  onRefresh={(path) => void refreshFile(path)}
                  refreshing={refreshing}
                />
              </>
            ) : null}
          </>
        ) : null}

        {tab === 'jobs' ? (
          <JobsPanel
            jobs={jobs}
            resultsByPath={resultsByPath}
            environment={environment}
            onCancel={(id) => void window.plexfixer.jobs.cancel(id)}
            onCancelAll={() => void window.plexfixer.jobs.cancelAll()}
            onClear={() => {
              void window.plexfixer.jobs.clearFinished()
              setJobs((previous) =>
                previous.filter((job) => job.state === 'queued' || job.state === 'running')
              )
            }}
            onReveal={(path) => void window.plexfixer.shell.reveal(path)}
          />
        ) : null}

        {tab === 'settings' ? (
          <SettingsPanel
            settings={settings}
            environment={environment}
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
                if (path) await updateSettings(name === 'ffmpeg' ? { ffmpegPath: path } : { ffprobePath: path })
              })()
            }}
            onRefreshEnvironment={() => {
              void (async () => setEnvironment(await window.plexfixer.environment.refresh()))()
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
