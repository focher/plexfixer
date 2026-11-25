import { useCallback, useEffect, useState } from 'react'
import type { AboutInfo, AnalysisResult, AppSettings, EnvironmentInfo, Job, JobLogEntry } from '@shared/types.js'
import { buildDiagnosticsReport, buildJobReport } from '@shared/report.js'
import { PHASE_LABEL, diagnoseMetrics, formatMs, phase, rankedPhases, summarizeMetrics } from '@shared/metrics.js'
import { STAGE_DETAIL, describeProgress, stalledSeconds, stepsFor } from '@shared/stages.js'
import { countCompleted, visibleJobs } from '@shared/jobs.js'
import { CopyIcon, FolderIcon, StopIcon } from './icons.js'
import { mediaTitle } from '@shared/plex/title.js'
import { readPref, writePref } from '../prefs.js'
import MenuButton from './MenuButton.js'

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

/**
 * What to call the file a job is working on.
 *
 * The analysis is the better source, since it holds the tags — but a job
 * outlives the row it came from: the library can be re-scanned, or the file
 * replaced and no longer at the path the job remembers. So this falls back to
 * reading the path's last segment the same way, rather than to showing the
 * path, which is what it used to do and what nobody recognises at a glance.
 */
function jobTitle(job: Job, result?: AnalysisResult): string {
  const file =
    result?.file ??
    ({
      fileName: job.sourcePath.split(/[\\/]/).pop() ?? job.sourcePath,
      tags: {}
    } as AnalysisResult['file'])

  const title = mediaTitle(file)
  const code = title.code ? `${title.code} ` : ''
  const name = title.episodeTitle ? `${title.title} — ${title.episodeTitle}` : title.title
  return `${code}${name}`
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

/**
 * Where the repair has got to, as steps rather than a number.
 *
 * The percentage only covers the copy. On another machine the steps either
 * side of it are the ones that go quiet — connecting, re-probing the finished
 * file over the link, moving it into place — and this is what distinguishes
 * "still working" from "stopped".
 */
function StageTrack({ job, now }: { job: Job; now: number }): React.JSX.Element | null {
  const steps = stepsFor(job)
  if (steps.length === 0) return null
  const stalled = stalledSeconds(job, now)
  const percent = job.stage === 'copying' ? Math.round(job.progress.fraction * 100) : undefined

  return (
    <div className="stage-track">
      {steps.map((step) => (
        <span key={step.stage} className={`stage-step ${step.state}`} title={STAGE_DETAIL[step.stage]}>
          <span className="dot" aria-hidden="true" />
          {step.label}
          {step.state === 'active' && percent != null ? <span className="pct"> {percent}%</span> : null}
        </span>
      ))}
      {job.host?.kind === 'remote' ? (
        <span className="stage-host" title={`This repair is running on ${job.host.label}`}>
          on {job.host.label}
        </span>
      ) : null}
      {stalled != null ? (
        <span className="stage-stall" title="Nothing has been reported for a while. The repair may still be working.">
          no update for {stalled}s
        </span>
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
  onClearQueue,
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
  /** Drop the repairs that have not started yet. */
  onClearQueue: () => void
  onReveal: (path: string) => void
  /** Write a report to a file the user picks; resolves to the path, or undefined. */
  onSave: (suggestedName: string, contents: string) => Promise<string | undefined>
}): React.JSX.Element {
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Ticks only while something is running, so an idle queue costs nothing.
  const [now, setNow] = useState(() => Date.now())
  const running = active.length > 0
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  const [copied, setCopied] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const [hideCompleted, setHideCompleted] = useState(() => readPref('hideCompleted'))

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
  const queued = jobs.filter((job) => job.state === 'queued')
  const completed = countCompleted(jobs)
  const visible = visibleJobs(jobs, hideCompleted)

  /**
   * The same switch the library has over "Hide passed", and there for the same
   * reason: once a long run is mostly successes, the few rows worth reading are
   * buried. It only hides repairs that succeeded, so a failure stays put.
   */
  const hideSwitch = (
    <label
      className={`toggle${hideCompleted ? ' on' : ''}`}
      title="Leave out repairs that finished successfully. Failures, cancellations and skips stay."
    >
      <input
        type="checkbox"
        checked={hideCompleted}
        onChange={(event) => {
          const on = event.target.checked
          setHideCompleted(on)
          writePref('hideCompleted', on)
        }}
      />
      <span className="switch" aria-hidden="true" />
      Hide completed
      <span className="count">{completed}</span>
    </label>
  )

  /**
   * The three ways of getting this session out of the app, behind one button.
   *
   * They were three buttons, one of which grew a count and shifted the two
   * beside it. They are also the buttons nobody presses until something has
   * gone wrong, which is the wrong claim on the width of a toolbar whose other
   * buttons are the ones that act on the queue.
   */
  const diagnosticsMenu = (
    <MenuButton
      label="Diagnostics"
      title="Copy or save a report of this session, for a bug report"
      items={[
        {
          key: 'copy',
          label: 'Copy diagnostics',
          hint: 'The build, the settings and every measurement from this session',
          onSelect: () => void copy('diagnostics', diagnostics())
        },
        {
          key: 'save',
          label: 'Save diagnostics…',
          hint: 'The same report, written to a file you pick',
          onSelect: () => void save()
        },
        {
          key: 'all',
          label: `Copy all reports${finished.length > 0 ? ` (${finished.length})` : ''}`,
          hint: 'A full report for every repair that has finished',
          disabled: finished.length === 0,
          disabledHint: 'No repair has finished yet',
          onSelect: () =>
            void copy('all', finished.map(reportFor).join('\n\n' + '='.repeat(72) + '\n\n'))
        }
      ]}
    />
  )

  /**
   * What just happened, beside the menu.
   *
   * The menu closes on the click, so the "Copied ✓" that used to live on the
   * button says so here. The saved path is a tooltip rather than text: it is
   * long enough to wrap the toolbar onto two rows and push the buttons around,
   * and the user chose the folder a moment ago in a save dialog.
   */
  const note = saved
    ? { text: 'Diagnostics saved ✓', title: saved }
    : copied === 'diagnostics'
      ? { text: 'Diagnostics copied ✓' }
      : copied === 'all'
        ? { text: 'Reports copied ✓' }
        : undefined

  if (jobs.length === 0) {
    return (
      <>
        <div className="toolbar queue-toolbar">
          <span className="spacer" />
          {note ? (
            <span className="muted nowrap" title={note.title}>
              {note.text}
            </span>
          ) : null}
          {diagnosticsMenu}
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
        {hideSwitch}
        {note ? (
          <span className="muted nowrap" title={note.title}>
            {note.text}
          </span>
        ) : null}
        {diagnosticsMenu}
        <button
          className="caution"
          onClick={onCancelAll}
          disabled={active.length === 0}
          title="Stop everything: what is running, what is waiting, and anything still being added. Repairs that never started are removed; finished ones stay."
        >
          Cancel all
        </button>
        <button onClick={onClear} disabled={finished.length === 0}>
          Clear finished
        </button>
        <button
          onClick={onClearQueue}
          disabled={queued.length === 0}
          title="Remove the repairs that have not started. Anything already running carries on, and finished jobs stay in the list."
        >
          Clear queue{queued.length > 0 ? ` (${queued.length})` : ''}
        </button>
      </div>

      {hideCompleted && visible.length === 0 ? (
        <div className="empty">Every repair here succeeded. Turn off Hide completed to see them.</div>
      ) : null}

      <div className="results">
        {visible.map((job) => {
          const open = expanded.has(job.id)
          const summary = summarizeMetrics(job.metrics)
          return (
            <div key={job.id}>
              <div className="job">
                <span className={`badge ${TONE[job.state]}`}>{job.state}</span>
                <span>
                  {/*
                    The title, as the library shows it. The queue used to show
                    a shortened path, which meant the same film was named one
                    way in the list and another here — and a path is the one
                    thing about a file nobody recognises at a glance.
                  */}
                  <div className="job-title">
                    {jobTitle(job, resultsByPath.get(job.sourcePath))}
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
                  <StageTrack job={job} now={now} />
                  <div className="job-actions">
                    <button className="ghost" onClick={() => toggle(job.id)} aria-expanded={open}>
                      {open ? '▾' : '▸'} {job.log.length} step{job.log.length === 1 ? '' : 's'}
                      {job.metrics ? ' and timings' : ''}
                    </button>
                    {/* The same icon, in the same place, as the one in the
                        library's detail panel: copying the report is one
                        action and should not have two appearances. */}
                    <button
                      className="icon-button"
                      onClick={() => void copy(job.id, reportFor(job))}
                      aria-label="Copy the report"
                      data-label={copied === job.id ? 'Copied' : 'Copy report'}
                    >
                      <CopyIcon />
                    </button>
                  </div>
                </span>
                <span className="muted nowrap" style={{ fontSize: 12 }}>
                  {job.state === 'running'
                    ? `${describeProgress(job)}${job.progress.speed ? ` · ${job.progress.speed}` : ''}${
                        job.progress.bytesWritten ? ` · ${formatBytes(job.progress.bytesWritten)}` : ''
                      }`
                    : (summary ??
                      (job.startedAt && job.finishedAt
                        ? `${Math.round((job.finishedAt - job.startedAt) / 1000)}s`
                        : ''))}
                </span>
                <span className="job-row-actions">
                  {job.state === 'queued' || job.state === 'running' ? (
                    <button
                      className="icon-button danger"
                      onClick={() => onCancel(job.id)}
                      aria-label="Stop this repair"
                      data-label="Stop"
                    >
                      <StopIcon />
                    </button>
                  ) : job.state === 'done' ? (
                    <button
                      className="icon-button"
                      onClick={() => onReveal(job.outputPath)}
                      aria-label="Show where the file is"
                      data-label="Show in folder"
                    >
                      <FolderIcon />
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
