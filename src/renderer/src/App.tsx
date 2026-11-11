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
import type { ResultFacet } from '@shared/plex/facets.js'
import { countFacets, filterResults } from '@shared/plex/facets.js'
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
      setSettings(loadedSettings)
      setLibrary(new Map(entries.map((entry) => [entry.path, entry])))
      setLibraryLoaded(true)
      // Capability detection runs test encodes, so it lands after the UI.
      setEnvironment(await window.plexfixer.environment.get())
    })()
  }, [])

  useEffect(() => {
    const offProgress = window.plexfixer.scan.onProgress((event) => {
      if (event.scanId !== scanIdRef.current) return
      setScanProgress({ processed: event.processed, total: event.total, currentPath: event.currentPath })
    })
    const offComplete = window.plexfixer.scan.onComplete((event) => {
      if (event.scanId !== scanIdRef.current) return
      // Merge into the library: scanned files are added or replaced, and files
      // a completed scan no longer finds under its folders are dropped.
      const put = event.results.map((result) => entryFromResult(result))
      const remove = stalePaths(libraryRef.current.keys(), event.inputPaths, event.foundPaths, event.cancelled)
      setLibrary((previous) => {
        const next = new Map(previous)
        for (const path of remove) next.delete(path)
        for (const entry of put) next.set(entry.path, entry)
        return next
      })
      void writeLibrary(put, remove).catch((error: unknown) => console.error('Could not save the scan', error))
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

  const counts = useMemo(() => {
    const result = { ok: 0, warn: 0, fail: 0, fixable: 0 }
    for (const entry of results) {
      if (entry.verdict === 'ok') result.ok++
      else if (entry.verdict === 'warn') result.warn++
      else result.fail++
      if (entry.plan.strategy !== 'none' && !entry.plan.requiresTranscode) result.fixable++
    }
    return result
  }, [results])

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
  const facetCounts = useMemo(() => countFacets(searched), [searched])
  const visibleResults = useMemo(() => filterResults(searched, facets), [searched, facets])

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
                <button
                  onClick={() => void refreshAll()}
                  disabled={library.size === 0}
                  title="Re-scan every folder in the library"
                >
                  Refresh all
                </button>
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
                  <div className="stat ok">
                    <div className="value">{counts.ok}</div>
                    <div className="label">Ready</div>
                  </div>
                  <div className="stat warn">
                    <div className="value">{counts.warn}</div>
                    <div className="label">Warnings</div>
                  </div>
                  <div className="stat fail">
                    <div className="value">{counts.fail}</div>
                    <div className="label">Blocked</div>
                  </div>
                  <div className="stat">
                    <div className="value">{counts.fixable}</div>
                    <div className="label">Lossless fix</div>
                  </div>
                  <div className="stat">
                    <div className="value">{needsTranscode.length}</div>
                    <div className="label">Need re-encode</div>
                  </div>
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
                  {query.trim() && facets.size === 0 ? (
                    <span className="muted nowrap">
                      {visibleResults.length} of {results.length}
                    </span>
                  ) : null}
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
