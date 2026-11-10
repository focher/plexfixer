import { useCallback, useState } from 'react'
import type { AnalysisResult, EnvironmentInfo, Job, JobLogEntry } from '@shared/types.js'
import { buildJobReport } from '@shared/report.js'
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
  onCancel,
  onCancelAll,
  onClear,
  onReveal
}: {
  jobs: Job[]
  resultsByPath: Map<string, AnalysisResult>
  environment?: EnvironmentInfo
  onCancel: (id: string) => void
  onCancelAll: () => void
  onClear: () => void
  onReveal: (path: string) => void
}): React.JSX.Element {
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string>()

  const toggle = (id: string): void =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const reportFor = useCallback(
    (job: Job): string =>
      buildJobReport({
        job,
        result: resultsByPath.get(job.sourcePath),
        environment,
        platform: navigator.userAgent.includes('Mac') ? 'macOS' : navigator.userAgent.includes('Win') ? 'Windows' : 'Linux'
      }),
    [resultsByPath, environment]
  )

  const copy = useCallback(
    async (key: string, text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(key)
        setTimeout(() => setCopied((current) => (current === key ? undefined : current)), 1800)
      } catch {
        // Clipboard can be refused; the log is still on screen to select by hand.
        setCopied(undefined)
      }
    },
    []
  )

  if (jobs.length === 0) {
    return <div className="empty">No repair jobs yet. Scan a folder, then press Repair.</div>
  }

  const finished = jobs.filter((job) => job.state !== 'queued' && job.state !== 'running')

  return (
    <>
      <div className="toolbar" style={{ padding: '0 0 12px', borderBottom: 'none' }}>
        <span className="muted">
          {active.length} active · {jobs.length} total
        </span>
        <span className="spacer" />
        <button
          onClick={() => void copy('all', finished.map(reportFor).join('\n\n' + '='.repeat(72) + '\n\n'))}
          disabled={finished.length === 0}
          title="Copy a full diagnostic report for every finished job"
        >
          {copied === 'all' ? 'Copied ✓' : `Copy all reports${finished.length > 0 ? ` (${finished.length})` : ''}`}
        </button>
        <button onClick={onCancelAll} disabled={active.length === 0}>
          Cancel all
        </button>
        <button onClick={onClear} disabled={active.length === jobs.length}>
          Clear finished
        </button>
      </div>

      <div className="results">
        {jobs.map((job) => {
          const open = expanded.has(job.id)
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
                    : job.startedAt && job.finishedAt
                      ? `${Math.round((job.finishedAt - job.startedAt) / 1000)}s`
                      : ''}
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
              {open ? <JobLog job={job} /> : null}
            </div>
          )
        })}
      </div>
    </>
  )
}
