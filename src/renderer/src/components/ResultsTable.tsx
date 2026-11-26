import type {
  AnalysisResult,
  AppSettings,
  EnvironmentInfo,
  Job,
  MetadataEdit,
  ModeOverrides,
  RepairMode
} from '@shared/types.js'
import { MODE_LABEL, resolveMode } from '@shared/mode.js'
import { summarizeReason } from '@shared/plex/reason.js'
import { fileStatus, type FileStatus } from '@shared/plex/facets.js'
import { describeProgress } from '@shared/stages.js'
import type { SortKey, SortState } from '@shared/sort.js'
import { formatAudioCodec, formatBytes, formatVideoCodec, parentDirectory } from '../format.js'
import { defaultAudioStream, videoStreams } from '@shared/plex/tracks.js'
import { BoltIcon, InfoIcon, RefreshIcon, TagIcon, WrenchIcon } from './icons.js'
import { mediaKindLabel, mediaTitle } from '@shared/plex/title.js'

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
  /** Queue a repair that writes metadata somebody set by hand. */
  onApplyMetadata?: (path: string, edit: MetadataEdit) => void
  /** A subtitle landed beside a film, so that row needs re-reading. */
  onSubtitleWritten?: (path: string) => void
  /** The row whose details are open in the panel beside the list. */
  activePath?: string
  /** Clicking a row opens it there rather than unfolding it here. */
  onOpen: (path: string) => void
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
  /**
   * Look one file up on themoviedb.org.
   *
   * Per row as well as in the Bulk menu, because looking one film up is the
   * commoner thing by far — a new rip lands, its tags are whatever the ripper
   * wrote, and selecting it to reach a menu is three clicks to do what the
   * row is already offering two of.
   */
  onLookUp?: (path: string) => void
  /** Why the lookup is unavailable, when it is. */
  lookUpDisabledHint?: string
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

/**
 * The technical facts, behind an icon.
 *
 * They were two columns of their own — size over codecs, and when it was
 * scanned — and they earned neither. Nobody scans a library to find out how
 * big the files are; they want to know what is wrong and what will be done
 * about it. So the facts move behind an icon beside the title, where they are
 * one hover away from whoever actually wants them, and the width they were
 * using goes to the two columns that answer the question.
 */
function Technical({ result }: { result: AnalysisResult }): React.JSX.Element {
  const { file } = result
  const video = videoStreams(file)[0]
  const resolution = video && video.kind === 'video' ? `${video.width}×${video.height}` : undefined
  const audio = defaultAudioStream(file)

  return (
    <span className="info-hover">
      <button className="icon-button info-button" aria-label="Technical details" title="">
        <InfoIcon />
      </button>
      <span className="info-card" role="tooltip">
        <span className="info-row">
          <span className="info-key">Folder</span>
          <span className="info-value mono">{parentDirectory(file.path)}</span>
        </span>
        <span className="info-row">
          <span className="info-key">File</span>
          <span className="info-value mono">{file.fileName}</span>
        </span>
        <span className="info-row">
          <span className="info-key">Video</span>
          <span className="info-value">
            {[resolution, formatVideoCodec(video?.codec), formatAudioCodec(audio?.codec)].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="info-row">
          <span className="info-key">Size</span>
          <span className="info-value">{formatBytes(file.sizeBytes)}</span>
        </span>
      </span>
    </span>
  )
}

/**
 * The plan's track changes with identical wording folded together.
 *
 * Two subtitle tracks rewritten the same way is one thing happening twice, not
 * two things, and printing the sentence twice only makes the column look
 * broken. Order is the order the plan listed them in.
 */
function countedReasons(changes: readonly { reason: string }[]): { reason: string; times: number }[] {
  const counts = new Map<string, number>()
  for (const change of changes) counts.set(change.reason, (counts.get(change.reason) ?? 0) + 1)
  return [...counts].map(([reason, times]) => ({ reason, times }))
}

export default function ResultsTable(props: ResultsTableProps): React.JSX.Element {
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
        <span>Type</span>
        <SortHeader label="Title" column="name" sort={props.sort} onSort={props.onSort} />
        <SortHeader label="Issues" column="reason" sort={props.sort} onSort={props.onSort} />
        <SortHeader label="Proposed action" column="plan" sort={props.sort} onSort={props.onSort} />
        <span>Action</span>
      </div>

      {props.results.map((result) => {
        const path = result.file.path
        const job = props.jobs.get(path)
        const jobActive = job?.state === 'queued' || job?.state === 'running'
        const nothingToDo = result.plan.strategy === 'none'
        const open = props.activePath === path
        const reason = summarizeReason(result)
        const title = mediaTitle(result.file)
        const changes = result.plan.trackChanges
        const isRefreshing = props.refreshing.has(path)
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
              className={`row${open ? ' open' : ''}`}
              aria-current={open ? 'true' : undefined}
              onClick={(event) => {
                // Controls in the row do their own thing, and a drag to select
                // a title should not open the panel.
                if ((event.target as HTMLElement).closest('button, input, select, a, label')) return
                if (window.getSelection()?.toString()) return
                props.onOpen(path)
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
              <span className="kind">{mediaKindLabel(title)}</span>
              <span className="title-cell">
                <span className="title-text">
                  <span className="title-main">
                    {title.code ? <span className="episode-code">{title.code}</span> : null}
                    <span className="title-name" title={title.guessed ? 'Read from the file name' : undefined}>
                      {title.title}
                    </span>
                    {title.year && !title.code ? <span className="title-year">{title.year}</span> : null}
                  </span>
                  {title.episodeTitle ? <span className="title-episode">{title.episodeTitle}</span> : null}
                </span>
                <Technical result={result} />
              </span>
              <span className="reason" title={reason.detail}>
                {/*
                  Every finding, one per line, rather than the first and a
                  "+2 more" count. The count told you something was missing
                  without telling you what, and there was nowhere to click to
                  find out — the row had to be opened, which is a long way
                  round for two words.
                */}
                <span className="reason-text">
                  {reason.titles.map((line, index) => (
                    <span key={`${line}-${index}`} className="reason-line" title={line}>
                      {line}
                    </span>
                  ))}
                </span>
                <span className="reason-note">
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
                {/*
                  What the repair will actually do to each track, which used to
                  be a column inside the expanded row. It belongs here: "remux"
                  says how the file is rewritten, and these say what changes —
                  which is the part anybody deciding whether to run it needs.
                */}
                {changes.length > 0 ? (
                  <span className="plan-changes">
                    {/*
                      All of them, for the same reason the issues are all
                      listed. Identical lines are counted rather than repeated:
                      a file with two ASS tracks produced the same sentence
                      twice, which reads as a bug rather than as two tracks.
                    */}
                    {countedReasons(changes).map(({ reason, times }) => (
                      <span key={reason} className="plan-change" title={reason}>
                        {reason}
                        {times > 1 ? ` ×${times}` : ''}
                      </span>
                    ))}
                  </span>
                ) : null}
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
                <button
                  className="icon-button"
                  onClick={() => props.onLookUp?.(path)}
                  disabled={!props.onLookUp || props.lookUpDisabledHint !== undefined}
                  aria-label={`Look up ${result.file.fileName}`}
                  title={
                    props.lookUpDisabledHint ??
                    'Metadata lookup — search themoviedb.org and review the answer before writing'
                  }
                >
                  <TagIcon />
                </button>
                {jobActive && job ? (
                  <span
                    className={`badge ${JOB_TONE[job.state]}`}
                    title={
                      job.host?.kind === 'remote'
                        ? `${describeProgress(job)} on ${job.host.label}`
                        : describeProgress(job)
                    }
                  >
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
          </div>
        )
      })}
    </div>
  )
}
