import { useEffect, useState } from 'react'
import type { AnalysisResult, AppSettings, EnvironmentInfo, Job, ModeOverrides, RepairMode } from '@shared/types.js'
import { MODE_LABEL, resolveMode } from '@shared/mode.js'
import { summarizeReason } from '@shared/plex/reason.js'
import { fileStatus, type FileStatus } from '@shared/plex/facets.js'
import FileDetail from './FileDetail.js'
import type { SortKey, SortState } from '@shared/sort.js'
import { formatAgo, formatAudioCodec, formatBytes, formatVideoCodec, parentDirectory, shortenPath } from '../format.js'
import { audioStreams, defaultAudioStream, videoStreams } from '@shared/plex/tracks.js'
import { BoltIcon, RefreshIcon, WrenchIcon } from './icons.js'

/** How an overridden mode shows in the row. */
const MODE_TONE: Record<RepairMode, string> = {
  report: 'neutral',
  'safe-remux': 'info',
  'force-transcode': 'warn'
}

/** The status column: what happens next for the file. */
const STATUS_BADGE: Record<FileStatus, { label: string; tone: string; hint: string }> = {
  passed: { label: 'passed', tone: 'ok', hint: 'Nothing to do — direct plays as it is (see details for any notes)' },
  fixable: { label: 'fixable', tone: 'info', hint: 'A lossless remux fixes this file' },
  reencode: { label: 're-encode', tone: 'warn', hint: 'Only a video re-encode fixes this file' },
  manual: { label: 'blocked', tone: 'fail', hint: 'No automatic repair fixes this — open the row for why, and what you can do' }
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
  /** Stamped into the diagnostic report a row can copy. */
  appVersion?: string
  onReveal: (path: string) => void
  /** Right-click on a row. */
  onContextMenu: (path: string) => void
  /** Re-analyse one file without rebuilding the whole table. */
  onRefresh: (path: string) => void
  /** Paths with a refresh in flight. */
  refreshing: Set<string>
  /** Which column the table is ordered by. */
  sort: SortState
  onSort: (key: SortKey) => void
}

/**
 * A column heading that sorts.
 *
 * `aria-sort` goes on the cell rather than the button, which is where a screen
 * reader looks for it; the arrow is the same information for everyone else.
 */
function SortHeader({
  label,
  column,
  sort,
  onSort,
  className
}: {
  label: string
  column: SortKey
  sort: SortState
  onSort: (key: SortKey) => void
  className?: string
}): React.JSX.Element {
  const active = sort.key === column
  return (
    <span
      className={`sortable${active ? ' sorted' : ''}${className ? ` ${className}` : ''}`}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button onClick={() => onSort(column)} title={`Sort by ${label.toLowerCase()}`}>
        {label}
        <span className="arrow" aria-hidden="true">
          {active ? (sort.direction === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </button>
    </span>
  )
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
        <SortHeader label="Status" column="status" sort={props.sort} onSort={props.onSort} />
        <SortHeader label="File" column="name" sort={props.sort} onSort={props.onSort} />
        <SortHeader label="Why" column="reason" sort={props.sort} onSort={props.onSort} />
        <SortHeader label="Plan" column="plan" sort={props.sort} onSort={props.onSort} />
        <SortHeader label="Technical" column="size" sort={props.sort} onSort={props.onSort} />
        <SortHeader label="Scanned" column="scanned" sort={props.sort} onSort={props.onSort} />
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
        // The first real video track; cover art is not the film's codec.
        const videoCodec = videoStreams(result.file)[0]?.codec
        // The track that plays by default, then how many others there are.
        const audioTracks = audioStreams(result.file)
        const defaultAudio = defaultAudioStream(result.file)
        const otherAudio = audioTracks.length - (defaultAudio ? 1 : 0)
        const codecLine = `${formatVideoCodec(videoCodec)}, ${formatAudioCodec(defaultAudio?.codec)}${otherAudio > 0 ? ` +${otherAudio}` : ''}`
        const audioDetail = audioTracks
          .map((track) => `${formatAudioCodec(track.codec)}${track === defaultAudio ? ' (default)' : ''}`)
          .join(', ')
        const statusKey = fileStatus(result)
        const status = STATUS_BADGE[statusKey]
        const plan = PLAN_BADGE[result.plan.strategy]
        // "Needs you" shows in the plan too: "nothing to do" would read as
        // finished. Any automatic part of the plan (a remux) still shows beside it.
        const manual = statusKey === 'manual'
        const showStrategy = !(manual && result.plan.strategy === 'none')
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
                {showStrategy ? (
                  <span
                    className={`badge ${plan.tone}`}
                    title={result.plan.costNote ? `${plan.hint}. ${result.plan.costNote}` : plan.hint}
                  >
                    {plan.label}
                  </span>
                ) : null}
                {manual ? (
                  <span
                    className="badge fail"
                    title="No automatic repair settles this — open the details to see what needs deciding"
                  >
                    manual
                  </span>
                ) : null}
                {job && !jobActive ? (
                  <span className={`badge ${JOB_TONE[job.state]}`} title={job.message}>
                    {job.state}
                  </span>
                ) : null}
              </span>
              <span
                className="technical"
                title={`${result.file.sizeBytes.toLocaleString()} bytes · ${formatVideoCodec(videoCodec)} · Audio: ${audioDetail || 'none'}`}
              >
                <span>{formatBytes(result.file.sizeBytes)}</span>
                <span className="muted">{codecLine}</span>
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
                appVersion={props.appVersion}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
