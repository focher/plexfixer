import { useCallback, useState } from 'react'
import type { AboutInfo, AnalysisResult, AppSettings, EnvironmentInfo, Job, JobLogEntry } from '@shared/types.js'
import { buildDiagnosticsReport, buildJobReport } from '@shared/report.js'
import { PHASE_LABEL, diagnoseMetrics, formatMs, phase, rankedPhases, summarizeMetrics } from '@shared/metrics.js'
import { shortenPath } from '../format.js'

const TONE: Record<Job['state'], string> = {
  queued: 'neutral',
  running: 'info',
  done: 'ok',
  failed: 'fail',
  cancelled: 'neutral',
  skipped: 'neutral'
}

/** Seconds since the job's first log entry, so steps read as a timeline. */
function offsetOf(entry: JobLogEntry, start: number): string {
  return `${((entry.at - start) / 1000).toFixed(1)}s`
}

function JobLog({ job }: { job: Job }): React.JSX.Element {
  const start = job.log[0]?.at ?? job.startedAt ?? Date.now()
  return (
    <div className="joblog">
      {job.log.map((entry, index) => (
        <div className={`joblog-entry ${entry.level}`} key={index}>
          <span className="at">{offsetOf(entry, start)}</span>
          <span className="body">
            <span className="step">{entry.text}</span>
            {entry.detail ? <pre className="detail">{entry.detail}</pre> : null}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Where the time went, as a bar per stage.
 *
 * The bars are drawn against the longest stage rather than the total, because
 * the question this answers is which stage dominated — and one stage nearly
 * always does.
 */
function JobTiming({ job }: { job: Job }): React.JSX.Element | null {
  const metrics = job.metrics
  if (!metrics) return null
  const stages = rankedPhases(metrics)
  if (stages.length === 0) return null
  const longest = stages[0]?.ms || 1
  const total = phase(metrics, 'total')
  const notes = diagnoseMetrics(metrics)

  return (
    <div className="timing">
      <div className="timing-head">
        <strong>Where the time went</strong>
        <span className="muted">{summarizeMetrics(metrics)}</span>
      </div>
      {stages.map((stage) => (
        <div className="timing-row" key={stage.phase}>
          <span className="timing-label" title={stage.note}>
            {PHASE_LABEL[stage.phase]}
          </span>
          <span className="timing-bar">
            <span style={{ width: `${Math.max(2, Math.round((stage.ms / longest) * 100))}%` }} />
          </span>
          <span className="timing-ms">{formatMs(stage.ms)}</span>
          <span className="timing-share muted">
            {total && total.ms > 0 ? `${Math.round((stage.ms / total.ms) * 100)}%` : ''}
          </span>
        </div>
      ))}
      {notes.length > 0 ? (
        <ul className="timing-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Bytes written so far, so a long copy visibly moves even at 0%. */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export default function JobsPanel({
  jobs,
  resultsByPath,
  environment,
  appVersion,
  about,
  settings,
  libraryCounts,
  onCancel,
  onCancelAll,
  onClear,
  onClearAll,
  onReveal,
  onSave
}: {
  jobs: Job[]
  resultsByPath: Map<string, AnalysisResult>
  environment?: EnvironmentInfo
  /** Stamped into the diagnostic report each job can copy. */
  appVersion?: string
  /** The build, for the diagnostics bundle. */
  about?: AboutInfo
  settings?: AppSettings
  /** How the library breaks down, for context in the diagnostics bundle. */
  libraryCounts?: { total: number; passed: number; fixable: number; reencode: number; blocked: number }
  onCancel: (id: string) => void
  onCancelAll: () => void
  onClear: () => void
  /** Stop everything and empty the list. */
  onClearAll: () => void
  onReveal: (path: string) => void
  /** Write a report to a file the user picks; resolves to the path, or undefined. */
  onSave: (suggestedName: string, contents: string) => Promise<string | undefined>
}): React.JSX.Element {
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string>()
  const [saved, setSaved] = useState<string>()

  const toggle = (id: string): void =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const platform = navigator.userAgent.includes('Mac')
    ? 'macOS'
    : navigator.userAgent.includes('Win')
      ? 'Windows'
      : 'Linux'

  const reportFor = useCallback(
    (job: Job): string =>
      buildJobReport({
        job,
        result: resultsByPath.get(job.sourcePath),
        environment,
        appVersion,
        platform
      }),
    [resultsByPath, environment, appVersion, platform]
  )

  /** Everything about this session at once: build, settings, and every measured repair. */
  const diagnostics = useCallback(
    (): string =>
      buildDiagnosticsReport({
        about,
        environment,
        settings,
        jobs,
        resultsByPath,
        library: libraryCounts,
        platform
      }),
    [about, environment, settings, jobs, resultsByPath, libraryCounts, platform]
  )

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((current) => (current === key ? undefined : current)), 1800)
    } catch {
      // Clipboard can be refused; the log is still on screen to select by hand.
      setCopied(undefined)
    }
  }, [])

  const save = useCallback(async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const path = await onSave(`plexfixer-diagnostics-${stamp}.txt`, diagnostics())
    if (!path) return
    setSaved(path)
    setTimeout(() => setSaved(undefined), 6000)
  }, [onSave, diagnostics])

  const finished = jobs.filter((job) => job.state !== 'queued' && job.state !== 'running')

  if (jobs.length === 0) {
    return (
      <>
        <div className="toolbar queue-toolbar">
          <span className="spacer" />
          <button onClick={() => void copy('diagnostics', diagnostics())} title="Copy the build, the settings and every measurement from this session">
            {copied === 'diagnostics' ? 'Copied ✓' : 'Copy diagnostics'}
          </button>
          <button onClick={() => void save()}>Save diagnostics…</button>
        </div>
        <div className="empty">Nothing in the queue. Scan a folder, then press Repair.</div>
      </>
    )
  }

  return (
    <>
      <div className="toolbar queue-toolbar">
        <span className="muted">
          {active.length} active · {jobs.length} total
        </span>
        <span className="spacer" />
        {saved ? <span className="muted nowrap">Saved to {shortenPath(saved, 2)}</span> : null}
        <button
          onClick={() => void copy('diagnostics', diagnostics())}
          title="Copy the build, the settings and every measurement from this session — the thing to paste into a bug report"
        >
          {copied === 'diagnostics' ? 'Copied ✓' : 'Copy diagnostics'}
        </button>
        <button onClick={() => void save()} title="Write the same diagnostics to a file">
          Save diagnostics…
        </button>
        <button
          onClick={() => void copy('all', finished.map(reportFor).join('\n\n' + '='.repeat(72) + '\n\n'))}
          disabled={finished.length === 0}
          title="Copy a full diagnostic report for every finished repair"
        >
          {copied === 'all' ? 'Copied ✓' : `Copy all reports${finished.length > 0 ? ` (${finished.length})` : ''}`}
        </button>
        <button onClick={onCancelAll} disabled={active.length === 0}>
          Cancel all
        </button>
        <button onClick={onClear} disabled={finished.length === 0}>
          Clear finished
        </button>
        <button
          onClick={() => {
            // Only worth asking when it would stop work that is under way;
            // emptying a list of finished jobs costs nothing.
            if (
              active.length > 0 &&
              !window.confirm(
                `Stop ${active.length} running or queued repair${active.length === 1 ? '' : 's'} and empty the list?`
              )
            ) {
              return
            }
            onClearAll()
          }}
          title="Stop anything still running and remove every job from the list"
        >
          Clear all
        </button>
      </div>

      <div className="results">
        {jobs.map((job) => {
          const open = expanded.has(job.id)
          const summary = summarizeMetrics(job.metrics)
          return (
            <div key={job.id}>
              <div className="job">
                <span className={`badge ${TONE[job.state]}`}>{job.state}</span>
                <span>
                  <div className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {shortenPath(job.sourcePath, 2)}
                  </div>
                  {job.message ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {job.message}
                    </div>
                  ) : null}
                  {job.state === 'running' ? (
                    <div className="progress" style={{ marginTop: 6 }}>
                      <div style={{ width: `${Math.round(job.progress.fraction * 100)}%` }} />
                    </div>
                  ) : null}
                  <div className="job-actions">
                    <button className="ghost" onClick={() => toggle(job.id)} aria-expanded={open}>
                      {open ? '▾' : '▸'} {job.log.length} step{job.log.length === 1 ? '' : 's'}
                      {job.metrics ? ' and timings' : ''}
                    </button>
                    <button className="ghost" onClick={() => void copy(job.id, reportFor(job))}>
                      {copied === job.id ? 'Copied ✓' : 'Copy report'}
                    </button>
                  </div>
                </span>
                <span className="muted nowrap" style={{ fontSize: 12 }}>
                  {job.state === 'running'
                    ? `${Math.round(job.progress.fraction * 100)}%${job.progress.speed ? ` · ${job.progress.speed}` : ''}${
                        job.progress.bytesWritten ? ` · ${formatBytes(job.progress.bytesWritten)}` : ''
                      }`
                    : (summary ??
                      (job.startedAt && job.finishedAt
                        ? `${Math.round((job.finishedAt - job.startedAt) / 1000)}s`
                        : ''))}
                </span>
                <span className="nowrap">
                  {job.state === 'queued' || job.state === 'running' ? (
                    <button className="ghost" onClick={() => onCancel(job.id)}>
                      Cancel
                    </button>
                  ) : job.state === 'done' ? (
                    <button className="ghost" onClick={() => onReveal(job.outputPath)}>
                      Reveal
                    </button>
                  ) : null}
                </span>
              </div>
              {open ? (
                <>
                  <JobTiming job={job} />
                  <JobLog job={job} />
                </>
              ) : null}
            </div>
          )
        })}
      </div>
    </>
  )
}
