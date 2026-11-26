import { useCallback, useState } from 'react'
import type {
  AnalysisResult,
  AppSettings,
  EnvironmentInfo,
  Job,
  ModeOverrides,
  OutputOverride,
  OutputPlacement,
  RepairMode
} from '@shared/types.js'
import { buildFileReport } from '@shared/report.js'
import { thisPlatform } from '../platform.js'
import { languageName } from '@shared/languages.js'
import { newId } from '@shared/ids.js'
import { MODE_LABEL, findOverrideKey, resolveMode, type ResolvedMode } from '@shared/mode.js'
import { blockedReasons } from '@shared/plex/blocked.js'
import MetadataDialog from './MetadataDialog.js'
import SubtitleDialog from './SubtitleDialog.js'
import type { MetadataEdit } from '@shared/types.js'
import { formatBitrate, formatBytes, formatDuration, parentDirectory, shortenPath } from '../format.js'
import { mediaTitle } from '@shared/plex/title.js'
import { CopyIcon, FolderIcon, PencilIcon } from './icons.js'
import TrackList from './TrackList.js'

/** One mode picker. `inherited` is what "Inherit" would give. */
function ModePicker({
  label,
  hint,
  current,
  inherited,
  onChange
}: {
  label: string
  hint?: string
  /** The override set on this exact path, or undefined when it inherits. */
  current?: RepairMode
  inherited: RepairMode
  onChange: (mode: RepairMode | null) => void
}): React.JSX.Element {
  return (
    <label className="mode-picker">
      <span className="mode-picker-label">
        {label}
        {hint ? (
          <span className="muted mono" title={hint}>
            {shortenPath(hint, 2)}
          </span>
        ) : null}
      </span>
      <select
        value={current ?? 'inherit'}
        className={current ? 'overridden' : undefined}
        onChange={(event) => {
          const value = event.target.value as RepairMode | 'inherit'
          onChange(value === 'inherit' ? null : value)
        }}
      >
        <option value="inherit">Inherit ({MODE_LABEL[inherited]})</option>
        <option value="report">Report only — never write</option>
        <option value="safe-remux">Safe remux — lossless fixes only</option>
        <option value="force-transcode">Force transcode — re-encode when needed</option>
      </select>
    </label>
  )
}

/** What Settings currently says, in the words the Settings screen uses. */
const PLACEMENT_LABEL: Record<OutputPlacement, string> = {
  sibling: 'Beside the original, with a suffix',
  'in-place': 'Replace the original',
  'output-dir': 'Into a separate folder'
}

/**
 * Where this file's repair is written, when that is not what Settings says.
 *
 * Settings holds the standing answer and most files never need another, so the
 * first option is to follow it — named, so you can see what you are following
 * without opening Settings. The other two are the answers somebody actually
 * wants for one file: keep it here, or put it somewhere with room.
 *
 * It replaced a second repair-mode picker, for the folder this file is in.
 * That one was a setting for a hundred files wearing the clothes of a setting
 * for one, sitting directly under the picker that really was for one — and the
 * two were a line apart and a word different.
 */
function OutputPicker({
  settings,
  value,
  onChange,
  onPickFolder
}: {
  settings: AppSettings
  value?: OutputOverride
  onChange: (next: OutputOverride | undefined) => void
  onPickFolder: () => Promise<string | undefined>
}): React.JSX.Element {
  const standing = PLACEMENT_LABEL[settings.outputPlacement]
  const choice = value?.placement ?? 'inherit'

  return (
    <label className="mode-picker">
      <span className="mode-picker-label">
        Output
        {value?.placement === 'output-dir' && value.directory ? (
          <span className="muted mono" title={value.directory}>
            {shortenPath(value.directory, 2)}
          </span>
        ) : null}
      </span>
      <select
        value={choice}
        className={value ? 'overridden' : undefined}
        onChange={(event) => {
          void (async () => {
            const next = event.target.value
            if (next === 'inherit') return onChange(undefined)
            if (next === 'sibling') return onChange({ placement: 'sibling' })
            // A folder with nothing in it is not a destination, so the picker
            // opens first and the choice is only made if one comes back.
            const directory = await onPickFolder()
            if (directory) onChange({ placement: 'output-dir', directory })
          })()
        }}
      >
        <option value="inherit">Use the setting ({standing})</option>
        <option value="sibling">Same folder as the file</option>
        <option value="output-dir">
          {value?.placement === 'output-dir' && value.directory ? 'Another folder…' : 'Another folder…'}
        </option>
      </select>
    </label>
  )
}

const SOURCE_LABEL: Record<AnalysisResult['primaryLanguageSource'], string> = {
  'video-stream-tag': 'from the video track’s language tag',
  'preferred-setting': 'from your preferred audio language',
  'majority-audio': 'from the majority of audio tracks',
  'first-audio': 'from the first audio track',
  fallback: 'assumed — nothing in the file said'
}

export default function FileDetail({
  result,
  job,
  onReveal,
  mode,
  defaultMode,
  overrides,
  onSetMode,
  settings,
  environment,
  appVersion,
  onApplyMetadata,
  onSubtitleWritten,
  onClose,
  outputOverride,
  onSetOutput
}: {
  result: AnalysisResult
  job?: Job
  onReveal: (path: string) => void
  /** The mode this file repairs in, and where that came from. */
  mode: ResolvedMode
  defaultMode: RepairMode
  overrides: ModeOverrides
  onSetMode: (path: string, mode: RepairMode | null) => void
  /** Included in the diagnostic report, since both shape the verdict. */
  settings?: AppSettings
  environment?: EnvironmentInfo
  appVersion?: string
  /** Queue a repair that writes what was set on the metadata screen. */
  onApplyMetadata?: (path: string, edit: MetadataEdit) => void
  /** A subtitle track went into the film, so the row's streams are stale. */
  onSubtitleWritten?: (path: string) => void
  /** Shown as a panel beside the list, which can be dismissed. */
  onClose?: () => void
  /** Where this file's repair goes, when that is not what Settings says. */
  outputOverride?: OutputOverride
  onSetOutput?: (next: OutputOverride | undefined) => void
}): React.JSX.Element {
  const { file, plan, findings } = result
  const [copied, setCopied] = useState(false)
  const [editingMetadata, setEditingMetadata] = useState(false)
  const [workingOnSubtitles, setWorkingOnSubtitles] = useState(false)
  /** Subtitle tracks with something running on them, by stream index. */
  const [busyTracks, setBusyTracks] = useState<Set<number>>(new Set())
  const [trackNote, setTrackNote] = useState<{ text: string; bad?: boolean }>()

  /**
   * Run one thing against one subtitle track.
   *
   * Both actions here rewrite the film, so both report what happened in the
   * same place and neither leaves the row looking idle while it works. The
   * row re-reads itself afterwards — a retimed or added track changes what the
   * file contains, and a panel still showing the old track list is a lie.
   */
  const onTrack = useCallback(
    async (streamIndex: number, what: string, work: (opId: string) => Promise<string | undefined>) => {
      setTrackNote({ text: `${what}…` })
      setBusyTracks((current) => new Set(current).add(streamIndex))
      try {
        const problem = await work(newId())
        setTrackNote(problem ? { text: problem, bad: true } : { text: `${what} — done.` })
        if (!problem) onSubtitleWritten?.(file.path)
      } catch (error) {
        setTrackNote({ text: error instanceof Error ? error.message : String(error), bad: true })
      } finally {
        setBusyTracks((current) => {
          const next = new Set(current)
          next.delete(streamIndex)
          return next
        })
      }
    },
    [file.path, onSubtitleWritten]
  )

  const copyReport = useCallback(async () => {
    const text = buildFileReport({
      result,
      settings,
      environment,
      appVersion,
      mode: mode.mode,
      modeSource: mode.source === 'default' ? 'the default' : `set on ${mode.from}`,
      platform: thisPlatform()
    })
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard can be refused; the detail pane is still on screen.
      setCopied(false)
    }
  }, [result, settings, environment, appVersion, mode])

  const blocked = blockedReasons(result)
  const folder = parentDirectory(file.path)
  const fileKey = findOverrideKey(file.path, overrides)
  // What this file would fall back to with no setting of its own: the nearest
  // folder above it with an override, or the global default.
  const inherited = resolveMode(folder, overrides, defaultMode)

  const title = mediaTitle(file)

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="detail-title">
          <div className="detail-title-main">
            {title.code ? <span className="episode-code">{title.code}</span> : null}
            {title.title}
          </div>
          {title.episodeTitle ? <div className="detail-title-episode">{title.episodeTitle}</div> : null}
          <div className="muted mono detail-path" title={file.path}>
            {shortenPath(folder, 3)}
          </div>
        </div>
        {onClose ? (
          <button className="icon-button" onClick={onClose} aria-label="Close" title="Close">
            ✕
          </button>
        ) : null}
      </div>

      {/*
        Three icons rather than three sentences. Each is one thing done to the
        file, and the words that used to be on them — "Reveal", "Copy report",
        "Edit metadata" — were a row of buttons wide enough to push everything
        else down the panel. The label is on hover, where a label belongs once
        the picture is unambiguous.
      */}
      <div className="detail-actions">
        <button
          className="icon-button"
          onClick={() => onReveal(file.path)}
          aria-label="Show where this file is"
          data-label="Show in folder"
        >
          <FolderIcon />
        </button>
        <button
          className="icon-button"
          onClick={() => void copyReport()}
          aria-label="Copy the report"
          data-label={copied ? 'Copied' : 'Copy report'}
        >
          <CopyIcon />
        </button>
        {onApplyMetadata && settings ? (
          <button
            className="icon-button"
            onClick={() => setEditingMetadata(true)}
            aria-label="Edit the metadata"
            data-label="Edit metadata"
          >
            <PencilIcon />
          </button>
        ) : null}
      </div>

      {workingOnSubtitles && settings ? (
        <SubtitleDialog
          result={result}
          settings={settings}
          onClose={() => setWorkingOnSubtitles(false)}
          onWrote={onSubtitleWritten ?? (() => undefined)}
        />
      ) : null}

      {editingMetadata && settings && onApplyMetadata ? (
        <MetadataDialog
          result={result}
          settings={settings}
          onClose={() => setEditingMetadata(false)}
          onApply={(edit) => {
            setEditingMetadata(false)
            onApplyMetadata(file.path, edit)
          }}
        />
      ) : null}
      <div className="muted" style={{ marginTop: 4 }}>
        {file.formatName} · {formatBytes(file.sizeBytes)} · {formatDuration(file.durationSeconds)} ·{' '}
        {formatBitrate(file.bitRate)}
        {file.container === 'mp4' ? ` · index ${file.faststart === false ? 'at end of file' : file.faststart ? 'at front (faststart)' : 'position unknown'}` : ''}
      </div>
      <div className="muted" style={{ marginTop: 4 }}>
        Primary language: <strong>{languageName(result.primaryLanguage)}</strong>{' '}
        <span className="muted">({SOURCE_LABEL[result.primaryLanguageSource]})</span>
      </div>
      <h4>Repair mode</h4>
      <div className="muted">
        Repairs in <strong>{MODE_LABEL[mode.mode]}</strong>
        {mode.source === 'file'
          ? ' — set on this file.'
          : mode.source === 'folder'
            ? (
                <>
                  {' — inherited from '}
                  <span title={mode.from}>{shortenPath(mode.from ?? '', 2)}</span>.
                </>
              )
            : ' — the default, since nothing above it is set.'}
      </div>
      <div className="mode-pickers">
        <ModePicker
          label="This file"
          hint={file.fileName}
          current={fileKey ? overrides[fileKey] : undefined}
          inherited={inherited.mode}
          onChange={(next) => onSetMode(fileKey ?? file.path, next)}
        />
        {settings ? (
          <OutputPicker
            settings={settings}
            value={outputOverride}
            onChange={(next) => onSetOutput?.(next)}
            onPickFolder={async () => window.plexfixer.dialog.pickDirectory()}
          />
        ) : null}
      </div>

      {blocked.length > 0 ? (
        <>
          <h4>
            Why this is blocked <span className="badge fail">no automatic fix</span>
          </h4>
          {blocked.map((reason) => (
            <div className="blocked-reason" key={reason.code}>
              <div className="title">{reason.title}</div>
              <div className="detail-text">{reason.why}</div>
              <div className="detail-text you-can">
                <strong>What you can do:</strong> {reason.youCan}
              </div>
            </div>
          ))}
        </>
      ) : null}

      <h4>Tracks</h4>
      {settings ? (
        <>
          <TrackList
            result={result}
            settings={settings}
            busy={busyTracks}
            onAddSubtitle={() => setWorkingOnSubtitles(true)}
            onResync={(streamIndex) =>
              void onTrack(streamIndex, `Resyncing track ${streamIndex}`, async (opId) => {
                const api = window.plexfixer.subtitles
                const outcome = await api.resync(opId, result, [streamIndex])
                if ('problem' in outcome) return outcome.problem
                const measured = outcome.tracks[0]
                if (!measured) return 'That track could not be measured against the audio.'
                // Saying "done" over a track that was already in step would be
                // a claim that something was fixed.
                if (!measured.moved) return undefined
                return undefined
              })
            }
            onTranslate={(streamIndex, language) =>
              void onTrack(streamIndex, `Translating track ${streamIndex} to ${languageName(language)}`, async (opId) => {
                const api = window.plexfixer.subtitles
                const source = file.streams.find((stream) => stream.index === streamIndex)
                const cues = await api.readTrack(opId, file.path, streamIndex)
                if ('problem' in cues) return cues.problem
                const done = await api.translate(opId, cues, source?.language ?? 'und', language)
                if ('problem' in done) return done.problem
                // A translation is a new track: the original stays, because it
                // is somebody's and this one is a machine's guess at it.
                const written = await api.write(opId, file.path, done.cues, language, {
                  streams: file.streams,
                  title: `${languageName(language)} (PlexFixer)`
                })
                return 'problem' in written ? written.problem : undefined
              })
            }
          />
          {trackNote ? (
            <p className={trackNote.bad ? 'detail-note bad' : 'detail-note'}>{trackNote.text}</p>
          ) : null}
        </>
      ) : null}

      <h4>
        Findings{' '}
        {findings.length === 0 ? <span className="badge ok">clean</span> : <span className="muted">({findings.length})</span>}
      </h4>
      {findings.length === 0 ? (
        <div className="muted">
          Nothing to flag — this file should direct play on every Plex client without server-side work.
        </div>
      ) : (
        findings.map((finding, index) => (
          <div className="finding" key={`${finding.code}-${index}`}>
            <span className={`badge ${finding.severity === 'blocker' ? 'fail' : finding.severity === 'warning' ? 'warn' : 'info'}`}>
              {finding.severity === 'blocker' ? 'blocker' : finding.severity}
            </span>
            <div className="body">
              <div className="title">{finding.title}</div>
              <div className="detail-text">{finding.detail}</div>
              {finding.streamIndexes && finding.streamIndexes.length > 0 ? (
                <div className="muted mono" style={{ fontSize: 11, marginTop: 2 }}>
                  track{finding.streamIndexes.length === 1 ? '' : 's'} {finding.streamIndexes.join(', ')}
                </div>
              ) : null}
            </div>
            <span className="badge neutral nowrap">
              {finding.remedy === 'lossless'
                ? 'lossless fix'
                : finding.remedy === 'transcode'
                  ? 'needs re-encode'
                  : finding.remedy === 'manual'
                    ? 'manual'
                    : '—'}
            </span>
          </div>
        ))
      )}

      <h4>Repair plan</h4>
      {plan.strategy === 'none' ? (
        <div className="muted">No changes needed.</div>
      ) : (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>
            Target: <strong>{plan.targetContainer.toUpperCase()}</strong> · {plan.costNote}
          </div>
          {plan.actions.map((action, index) => (
            <div className="plan-action" key={index}>
              <div className="label">{action.label}</div>
              <div className="detail-text">{action.detail}</div>
            </div>
          ))}
          {plan.unresolved.length > 0 ? (
            <div className="banner" style={{ marginTop: 12, marginBottom: 0 }}>
              <strong>Not fixed by this plan:</strong>{' '}
              {plan.unresolved.map((finding) => finding.title).join('; ')}.
              {plan.requiresTranscode
                ? ' Set this file or its folder to Force transcode to re-encode the video.'
                : ''}
            </div>
          ) : null}
        </>
      )}

      {job?.command ? (
        <>
          <h4>Command</h4>
          <pre className="command">{job.command.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(' ')}</pre>
        </>
      ) : null}
    </div>
  )
}
