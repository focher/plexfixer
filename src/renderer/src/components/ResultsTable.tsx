import { useEffect, useState } from 'react'
import type { AnalysisResult, AppSettings, EnvironmentInfo, Job, ModeOverrides, RepairMode } from '@shared/types.js'
import { MODE_LABEL, resolveMode } from '@shared/mode.js'
import { summarizeReason } from '@shared/plex/reason.js'
import { fileStatus, type FileStatus } from '@shared/plex/facets.js'
import FileDetail from './FileDetail.js'
import { formatAgo, parentDirectory, shortenPath } from '../format.js'
import { BoltIcon, RefreshIcon, WrenchIcon } from './icons.js'

/** How an overridden mode shows in the row. */
const MODE_TONE: Record<RepairMode, string> = {
  report: 'neutral',
  'safe-remux': 'info',
  'force-transcode': 'warn'
}

/** The status column: what happens next for the file. */
const STATUS_BADGE: Record<FileStatus, { label: string; tone: string; hint: string }> = {
  passed: { label: 'passed', tone: 'ok', hint: 'Passed every check — direct plays as it is' },
  fixable: { label: 'fixable', tone: 'info', hint: 'A lossless remux fixes this file' },
  reencode: { label: 're-encode', tone: 'warn', hint: 'Only a video re-encode fixes this file' },
  manual: { label: 'needs you', tone: 'fail', hint: 'No automatic repair fixes this — see the details' }
}

/** The plan column: the repair, short, with the long form on hover. */
const PLAN_BADGE: Record<AnalysisResult['plan']['strategy'], { label: string; tone: string; hint: string }> = {
  none: { label: 'nothing to do', tone: 'ok', hint: 'Nothing to do' },
  remux: { label: 'remux', tone: 'info', hint: 'Remux' },
  'transcode-audio': { label: 'remux + AAC', tone: 'info', hint: 'Remux and add an AAC track' },
  'transcode-video': { label: 're-encode', tone: 'warn', hint: 'Re-encode the video' }
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
  /** Leave `mode` out to repair in the file's own mode. */
  onRepair: (paths: string[], mode?: RepairMode) => void
  /** Per-file and per-folder mode overrides, and the fallback they resolve against. */
  overrides: ModeOverrides
  defaultMode: RepairMode
  onSetMode: (path: string, mode: RepairMode | null) => void
  /** Passed through to each row's report button. */
  settings?: AppSettings
  environment?: EnvironmentInfo
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
        const status = STATUS_BADGE[fileStatus(result)]
        const plan = PLAN_BADGE[result.plan.strategy]
        const mode = resolveMode(path, props.overrides, props.defaultMode)
        const reportOnly = mode.mode === 'report'

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
                <span className={`badge ${status.tone}`} title={status.hint}>
                  {status.label}
                </span>
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
                  <button className="more" onClick={() => toggleExpanded(path)} aria-expanded={open}>
                    {open ? 'hide' : reason.others > 0 ? `+${reason.others} more` : 'details'}
                  </button>
                  {mode.source !== 'default' ? (
                    <span
                      className={`badge ${MODE_TONE[mode.mode]}`}
                      title={
                        mode.source === 'file'
                          ? `This file is set to ${MODE_LABEL[mode.mode]}`
                          : `Inherited from ${mode.from} — ${MODE_LABEL[mode.mode]}`
                      }
                    >
                      {MODE_LABEL[mode.mode].toLowerCase()}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="plan">
                <span
                  className={`badge ${plan.tone}`}
                  title={result.plan.costNote ? `${plan.hint}. ${result.plan.costNote}` : plan.hint}
                >
                  {plan.label}
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
                      disabled={nothingToDo || result.plan.requiresTranscode || reportOnly}
                      aria-label={`Safe remux ${result.file.fileName}`}
                      title={
                        nothingToDo
                          ? 'Already Plex-ready'
                          : reportOnly
                            ? 'This file is in report-only mode — change it in the details'
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
                      disabled={nothingToDo || reportOnly}
                      aria-label={`Force transcode ${result.file.fileName}`}
                      title={
                        nothingToDo
                          ? 'Already Plex-ready'
                          : reportOnly
                            ? 'This file is in report-only mode — change it in the details'
                            : 'Force transcode — fix everything, re-encoding video if needed'
                      }
                    >
                      <BoltIcon />
                    </button>
                  </>
                )}
              </span>
            </div>
            {open ? (
              <FileDetail
                result={result}
                job={job}
                onReveal={props.onReveal}
                mode={mode}
                defaultMode={props.defaultMode}
                overrides={props.overrides}
                onSetMode={props.onSetMode}
                settings={props.settings}
                environment={props.environment}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
