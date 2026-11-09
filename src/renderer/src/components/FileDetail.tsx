import type { AnalysisResult, Job } from '@shared/types.js'
import { languageName } from '@shared/languages.js'
import StreamTable from './StreamTable.js'
import { formatBitrate, formatBytes, formatDuration } from '../format.js'

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
  onReveal
}: {
  result: AnalysisResult
  job?: Job
  onReveal: (path: string) => void
}): React.JSX.Element {
  const { file, plan, findings } = result

  return (
    <div className="detail">
      <h4>File</h4>
      <div className="muted">
        <code>{file.path}</code>{' '}
        <button className="ghost" onClick={() => onReveal(file.path)}>
          Reveal
        </button>
      </div>
      <div className="muted" style={{ marginTop: 4 }}>
        {file.formatName} · {formatBytes(file.sizeBytes)} · {formatDuration(file.durationSeconds)} ·{' '}
        {formatBitrate(file.bitRate)}
        {file.container === 'mp4' ? ` · index ${file.faststart === false ? 'at end of file' : file.faststart ? 'at front (faststart)' : 'position unknown'}` : ''}
      </div>
      <div className="muted" style={{ marginTop: 4 }}>
        Primary language: <strong>{languageName(result.primaryLanguage)}</strong>{' '}
        <span className="muted">({SOURCE_LABEL[result.primaryLanguageSource]})</span>
      </div>
      {file.sidecarSubtitles.length > 0 ? (
        <div className="muted" style={{ marginTop: 4 }}>
          {file.sidecarSubtitles.length} sidecar subtitle file
          {file.sidecarSubtitles.length === 1 ? '' : 's'} alongside this file
        </div>
      ) : null}

      <h4>Tracks</h4>
      <StreamTable result={result} />

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
