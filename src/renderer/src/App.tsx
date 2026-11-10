import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnalysisResult,
  AppSettings,
  EnvironmentInfo,
  Job,
  ModeOverrides,
  RepairMode,
  ScanError
} from '@shared/types.js'
import ResultsTable from './components/ResultsTable.js'
import JobsPanel from './components/JobsPanel.js'
import SettingsPanel from './components/SettingsPanel.js'
import { parentDirectory } from './format.js'

type Tab = 'library' | 'jobs' | 'settings'

/**
 * Resolve the effective mode for a path: an override on the file wins, then the
 * nearest ancestor folder with an override, then the global default. Mirrors
 * `resolveMode` in the main process so the UI shows what will actually happen.
 */
function resolveModeFor(path: string, overrides: ModeOverrides, fallback: RepairMode): RepairMode {
  const direct = overrides[path]
  if (direct) return direct
  let best: { length: number; mode: RepairMode } | undefined
  for (const [key, mode] of Object.entries(overrides)) {
    if (key === path) continue
    if (path.startsWith(`${key}/`) || path.startsWith(`${key}\\`)) {
      if (!best || key.length > best.length) best = { length: key.length, mode }
    }
  }
  return best?.mode ?? fallback
}

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('library')
  const [settings, setSettings] = useState<AppSettings>()
  const [environment, setEnvironment] = useState<EnvironmentInfo>()
  const [overrides, setOverrides] = useState<ModeOverrides>({})

  const [results, setResults] = useState<AnalysisResult[]>([])
  const [scanErrors, setScanErrors] = useState<ScanError[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<{ processed: number; total: number; currentPath?: string }>()
  const [jobs, setJobs] = useState<Job[]>([])
  const [dragging, setDragging] = useState(false)
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())

  const scanIdRef = useRef<string | undefined>(undefined)
  const lastPathsRef = useRef<string[]>([])
  // Read inside `refreshFile`, which must not re-create itself on every job
  // update or every row would lose its handler mid-repair.
  const jobsByPathRef = useRef<Map<string, Job>>(new Map())

  /* --- bootstrap ------------------------------------------------------ */

  useEffect(() => {
    void (async () => {
      const [loadedSettings, loadedOverrides] = await Promise.all([
        window.plexfixer.settings.get(),
        window.plexfixer.overrides.get()
      ])
      setSettings(loadedSettings)
      setOverrides(loadedOverrides)
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
      setResults(event.results)
      setScanErrors(event.errors)
      setSelected(new Set(event.results.filter((r) => r.plan.strategy !== 'none').map((r) => r.file.path)))
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
    lastPathsRef.current = paths
    // The id is generated here and recorded synchronously, so events for this
    // scan are never discarded because the await had not resolved yet.
    const scanId = crypto.randomUUID()
    scanIdRef.current = scanId
    setScanning(true)
    setResults([])
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
    const next = await window.plexfixer.settings.update(patch)
    setSettings(next)
    // Compatibility verdicts depend on settings, so a change invalidates the
    // current results; re-run against the same inputs rather than showing stale
    // findings.
    if (lastPathsRef.current.length > 0 && results.length > 0) {
      const affectsAnalysis = Object.keys(patch).some(
        (key) => !['concurrency', 'outputPlacement', 'outputDirectory', 'keepBackups', 'outputSuffix'].includes(key)
      )
      if (affectsAnalysis) {
        const scanId = crypto.randomUUID()
        scanIdRef.current = scanId
        setScanning(true)
        await window.plexfixer.scan.start(lastPathsRef.current, scanId)
      }
    }
    if ('ffmpegPath' in patch || 'ffprobePath' in patch) {
      setEnvironment(await window.plexfixer.environment.refresh())
    }
  }, [results.length])

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
          const fresh = response.result
          setResults((previous) => previous.map((entry) => (entry.file.path === path ? fresh : entry)))
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
          setResults((previous) => previous.filter((entry) => entry.file.path !== path))
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

  /** Re-scan everything the table was built from, keeping the same inputs. */
  const refreshAll = useCallback(async () => {
    if (lastPathsRef.current.length > 0) await startScan(lastPathsRef.current)
  }, [startScan])

  const setMode = useCallback(async (path: string, mode: RepairMode | null) => {
    setOverrides(await window.plexfixer.overrides.set(path, mode))
  }, [])

  /**
   * Queue repairs. Passing a mode overrides the per-file/per-folder setting for
   * this run only — that is what the "Force transcode it now" action does,
   * without permanently changing the file's mode.
   */
  const repair = useCallback(async (paths: string[], mode?: RepairMode) => {
    await window.plexfixer.jobs.enqueue(paths, mode)
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

  const resolveMode = useCallback(
    (path: string) => resolveModeFor(path, overrides, settings?.defaultMode ?? 'safe-remux'),
    [overrides, settings?.defaultMode]
  )

  const resultsByPath = useMemo(() => {
    const map = new Map<string, AnalysisResult>()
    for (const entry of results) map.set(entry.file.path, entry)
    return map
  }, [results])

  const scannedFolders = useMemo(() => {
    const folders = new Set<string>()
    for (const entry of results) folders.add(parentDirectory(entry.file.path))
    return [...folders].sort()
  }, [results])

  if (!settings) {
    return (
      <div className="app">
        <div className="titlebar">PlexFixer</div>
        <div className="content">
          <div className="empty">Loading…</div>
        </div>
      </div>
    )
  }

  const selectedPaths = [...selected]

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
                  className="primary"
                  disabled={selectedPaths.length === 0}
                  onClick={() => void repair(selectedPaths)}
                >
                  Repair selected
                </button>
              </>
            ) : null}
            {scanning ? (
              <button onClick={() => void cancelScan()}>Cancel scan</button>
            ) : (
              <>
                <button
                  onClick={() => void refreshAll()}
                  disabled={lastPathsRef.current.length === 0}
                  title="Re-scan everything in the list"
                >
                  Refresh all
                </button>
                <button onClick={() => void choosePaths()}>Choose files or folder…</button>
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
                  Choose files or folder…
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
                    A safe remux will skip {needsTranscode.length === 1 ? 'it' : 'them'}. Set the file — or its folder —
                    to Force transcode to re-encode the video.
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button onClick={() => void repair(needsTranscode, 'force-transcode')}>
                        Force transcode {needsTranscode.length === 1 ? 'it' : 'these'} now
                      </button>
                      {scannedFolders.length === 1 ? (
                        <button onClick={() => void setMode(scannedFolders[0], 'force-transcode')}>
                          Set this folder to Force transcode
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <ResultsTable
                  results={results}
                  jobs={jobsByPath}
                  selected={selected}
                  overrides={overrides}
                  defaultMode={settings.defaultMode}
                  resolveMode={resolveMode}
                  onToggleSelect={(path) =>
                    setSelected((previous) => {
                      const next = new Set(previous)
                      if (next.has(path)) next.delete(path)
                      else next.add(path)
                      return next
                    })
                  }
                  onToggleAll={() =>
                    setSelected((previous) =>
                      previous.size === results.length ? new Set() : new Set(results.map((r) => r.file.path))
                    )
                  }
                  onSetMode={(path, mode) => void setMode(path, mode)}
                  onRepair={(paths) => void repair(paths)}
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
