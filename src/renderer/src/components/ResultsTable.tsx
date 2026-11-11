import { useEffect, useState } from 'react'
import type { AnalysisResult, Job, RepairMode } from '@shared/types.js'
import { summarizeReason, type ReasonTone } from '@shared/plex/reason.js'
import FileDetail from './FileDetail.js'
import { formatAgo, parentDirectory, shortenPath } from '../format.js'
import { BoltIcon, RefreshIcon, WrenchIcon } from './icons.js'

const VERDICT_LABEL: Record<AnalysisResult['verdict'], string> = {
  ok: 'passed',
  warn: 'warning',
  fail: 'blocked',
  error: 'error'
}

const STRATEGY_LABEL: Record<AnalysisResult['plan']['strategy'], string> = {
  none: 'Nothing to do',
  remux: 'Remux (stream copy)',
  'transcode-audio': 'Remux + add AAC',
  'transcode-video': 'Re-encode video'
}

/** Badge colour for the outcome note under each reason. */
const REASON_TONE: Record<ReasonTone, string> = {
  ok: 'ok',
  fix: 'info',
  transcode: 'warn',
  manual: 'fail'
}

const JOB_TONE: Record<Job['state'], string> = {
  queued: 'neutral',
  running: 'info',
  done: 'ok',
  failed: 'fail',
  cancelled: 'neutral',
  skipped: 'neutral'
}

export interface ResultsTableProps {
  results: AnalysisResult[]
  jobs: Map<string, Job>
  selected: Set<string>
  onToggleSelect: (path: string) => void
  onToggleAll: () => void
  onRepair: (paths: string[], mode: RepairMode) => void
  onReveal: (path: string) => void
  /** Right-click on a row. */
  onContextMenu: (path: string) => void
  /** Re-analyse one file without rebuilding the whole table. */
  onRefresh: (path: string) => void
  /** Paths with a refresh in flight. */
  refreshing: Set<string>
}

export default function ResultsTable(props: ResultsTableProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Ticks so the "Scanned" column ages without the parent re-rendering.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const toggleExpanded = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const allSelected = props.results.length > 0 && props.results.every((r) => props.selected.has(r.file.path))

  return (
    <div className="results">
      <div className="row header">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={props.onToggleAll}
          aria-label="Select all files"
        />
        <span>Status</span>
        <span>File</span>
        <span>Why</span>
        <span>Plan</span>
        <span>Scanned</span>
        <span>Action</span>
      </div>

      {props.results.map((result) => {
        const path = result.file.path
        const job = props.jobs.get(path)
        const jobActive = job?.state === 'queued' || job?.state === 'running'
        const nothingToDo = result.plan.strategy === 'none'
        const open = expanded.has(path)
        const reason = summarizeReason(result)
        const isRefreshing = props.refreshing.has(path)

        return (
          <div key={path}>
            <div
              className="row"
              onClick={(event) => {
                // Controls in the row do their own thing, and a drag to select
                // a file name should not toggle the row open.
                if ((event.target as HTMLElement).closest('button, input, select, a, label')) return
                if (window.getSelection()?.toString()) return
                toggleExpanded(path)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                props.onContextMenu(path)
              }}
            >
              <input
                type="checkbox"
                checked={props.selected.has(path)}
                onChange={() => props.onToggleSelect(path)}
                aria-label={`Select ${result.file.fileName}`}
              />
              <span>
                <span className={`badge ${result.verdict}`}>{VERDICT_LABEL[result.verdict]}</span>
              </span>
              <span className="name">
                <button className="expander" onClick={() => toggleExpanded(path)} aria-expanded={open}>
                  {open ? '▾' : '▸'}
                </button>
                <span className="name-text">
                  {result.file.fileName}
                  <span className="dir">{shortenPath(parentDirectory(path), 2)}</span>
                </span>
              </span>
              <span className="reason" title={reason.detail}>
                <span className="reason-text">{reason.headline}</span>
                <span className="reason-note">
                  <span className={`badge ${REASON_TONE[reason.tone]}`}>{reason.outcome}</span>
                  <button className="more" onClick={() => toggleExpanded(path)} aria-expanded={open}>
                    {open ? 'hide' : reason.others > 0 ? `+${reason.others} more` : 'details'}
                  </button>
                </span>
              </span>
              <span className="plan">
                <span className="muted nowrap" style={{ fontSize: 12 }}>
                  {STRATEGY_LABEL[result.plan.strategy]}
                </span>
                {job && !jobActive ? (
                  <span className={`badge ${JOB_TONE[job.state]}`} title={job.message}>
                    {job.state}
                  </span>
                ) : null}
              </span>
              <span
                className="muted nowrap"
                style={{ fontSize: 12 }}
                title={result.scannedAt ? new Date(result.scannedAt).toLocaleString() : undefined}
              >
                {formatAgo(result.scannedAt, now)}
              </span>
              <span className="actions">
                <button
                  className="icon-button"
                  onClick={() => props.onRefresh(path)}
                  disabled={isRefreshing}
                  aria-label={`Re-scan ${result.file.fileName}`}
                  title="Re-scan this file"
                >
                  <RefreshIcon className={isRefreshing ? 'spin' : undefined} />
                </button>
                {jobActive && job ? (
                  <span className={`badge ${JOB_TONE[job.state]}`} title={job.message}>
                    {job.state === 'running' ? `${Math.round(job.progress.fraction * 100)}%` : job.state}
                  </span>
                ) : (
                  <>
                    <button
                      className="icon-button"
                      onClick={() => props.onRepair([path], 'safe-remux')}
                      disabled={nothingToDo || result.plan.requiresTranscode}
                      aria-label={`Safe remux ${result.file.fileName}`}
                      title={
                        nothingToDo
                          ? 'Already Plex-ready'
                          : result.plan.requiresTranscode
                            ? 'Needs a re-encode — use Force transcode'
                            : 'Safe remux — apply the lossless fixes'
                      }
                    >
                      <WrenchIcon />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => props.onRepair([path], 'force-transcode')}
                      disabled={nothingToDo}
                      aria-label={`Force transcode ${result.file.fileName}`}
                      title={
                        nothingToDo
                          ? 'Already Plex-ready'
                          : 'Force transcode — fix everything, re-encoding video if needed'
                      }
                    >
                      <BoltIcon />
                    </button>
                  </>
                )}
              </span>
            </div>
            {open ? <FileDetail result={result} job={job} onReveal={props.onReveal} /> : null}
          </div>
        )
      })}
    </div>
  )
}
