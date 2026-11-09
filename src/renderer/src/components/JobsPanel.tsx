import type { Job } from '@shared/types.js'
import { shortenPath } from '../format.js'

const TONE: Record<Job['state'], string> = {
  queued: 'neutral',
  running: 'info',
  done: 'ok',
  failed: 'fail',
  cancelled: 'neutral',
  skipped: 'neutral'
}

export default function JobsPanel({
  jobs,
  onCancel,
  onCancelAll,
  onClear,
  onReveal
}: {
  jobs: Job[]
  onCancel: (id: string) => void
  onCancelAll: () => void
  onClear: () => void
  onReveal: (path: string) => void
}): React.JSX.Element {
  const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running')

  if (jobs.length === 0) {
    return <div className="empty">No repair jobs yet. Scan a folder, then press Repair.</div>
  }

  return (
    <>
      <div className="toolbar" style={{ padding: '0 0 12px', borderBottom: 'none' }}>
        <span className="muted">
          {active.length} active · {jobs.length} total
        </span>
        <span className="spacer" />
        <button onClick={onCancelAll} disabled={active.length === 0}>
          Cancel all
        </button>
        <button onClick={onClear} disabled={active.length === jobs.length}>
          Clear finished
        </button>
      </div>

      <div className="results">
        {jobs.map((job) => (
          <div className="job" key={job.id}>
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
            </span>
            <span className="muted nowrap" style={{ fontSize: 12 }}>
              {job.state === 'running'
                ? `${Math.round(job.progress.fraction * 100)}%${job.progress.speed ? ` · ${job.progress.speed}` : ''}`
                : job.state === 'done' && job.startedAt && job.finishedAt
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
        ))}
      </div>
    </>
  )
}
