import { useState } from 'react'
import type { AnalysisResult, Job, ModeOverrides, RepairMode } from '@shared/types.js'
import { summarizeReason, type ReasonTone } from '@shared/plex/reason.js'
import FileDetail from './FileDetail.js'
import { parentDirectory, shortenPath } from '../format.js'

const VERDICT_LABEL: Record<AnalysisResult['verdict'], string> = {
  ok: 'ready',
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

const MODE_LABEL: Record<RepairMode, string> = {
  report: 'Report only',
  'safe-remux': 'Safe remux',
  'force-transcode': 'Force transcode'
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
  overrides: ModeOverrides
  defaultMode: RepairMode
  resolveMode: (path: string) => RepairMode
  onToggleSelect: (path: string) => void
  onToggleAll: () => void
  onSetMode: (path: string, mode: RepairMode | null) => void
  onRepair: (paths: string[]) => void
  onReveal: (path: string) => void
  /** Re-analyse one file without rebuilding the whole table. */
  onRefresh: (path: string) => void
  /** Paths with a refresh in flight. */
  refreshing: Set<string>
}

export default function ResultsTable(props: ResultsTableProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

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
        <span>Mode</span>
        <span>Action</span>
      </div>

      {props.results.map((result) => {
        const path = result.file.path
        const job = props.jobs.get(path)
        const mode = props.resolveMode(path)
        const isOverridden = props.overrides[path] != null
        const open = expanded.has(path)
        const reason = summarizeReason(result)
        const isRefreshing = props.refreshing.has(path)

        return (
          <div key={path}>
            <div className="row">
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
                <button
                  className="refresh"
                  onClick={() => props.onRefresh(path)}
                  disabled={isRefreshing}
                  aria-label={`Re-scan ${result.file.fileName}`}
                  title="Re-scan just this file"
                >
                  <span className={isRefreshing ? 'spin' : undefined}>⟳</span>
                </button>
              </span>
              <span className="reason" title={reason.detail}>
                <span className="reason-text">{reason.headline}</span>
                <span className="reason-note">
                  <span className={`badge ${REASON_TONE[reason.tone]}`}>{reason.outcome}</span>
                  {reason.others > 0 ? (
                    <button className="more" onClick={() => toggleExpanded(path)}>
                      +{reason.others} more
                    </button>
                  ) : null}
                </span>
              </span>
              <span className="muted nowrap" style={{ fontSize: 12 }}>
                {STRATEGY_LABEL[result.plan.strategy]}
              </span>
              <span>
                <select
                  value={mode}
                  onChange={(event) => {
                    const value = event.target.value as RepairMode | 'inherit'
                    props.onSetMode(path, value === 'inherit' ? null : value)
                  }}
                  style={isOverridden ? { borderColor: 'var(--accent)' } : undefined}
                  title={
                    isOverridden
                      ? 'Overridden for this file'
                      : 'Inherited from the folder or the global default'
                  }
                >
                  <option value="inherit">Inherit ({MODE_LABEL[props.defaultMode]})</option>
                  <option value="report">{MODE_LABEL.report}</option>
                  <option value="safe-remux">{MODE_LABEL['safe-remux']}</option>
                  <option value="force-transcode">{MODE_LABEL['force-transcode']}</option>
                </select>
              </span>
              <span className="nowrap">
                {job ? (
                  <span className={`badge ${JOB_TONE[job.state]}`} title={job.message}>
                    {job.state === 'running'
                      ? `${Math.round(job.progress.fraction * 100)}%`
                      : job.state}
                  </span>
                ) : (
                  <button
                    onClick={() => props.onRepair([path])}
                    disabled={result.plan.strategy === 'none' || mode === 'report'}
                    title={
                      result.plan.strategy === 'none'
                        ? 'Already Plex-ready'
                        : mode === 'report'
                          ? 'This file is in report-only mode'
                          : 'Apply the repair plan'
                    }
                  >
                    Repair
                  </button>
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
