import type { AnalysisResult, AudioStream, MediaStream, SubtitleStream, VideoStream } from '@shared/types.js'
import { languageName } from '@shared/languages.js'
import { formatLevel } from '@shared/plex/rules.js'
import { formatBitrate } from '../format.js'

function describe(stream: MediaStream): string {
  switch (stream.kind) {
    case 'video': {
      const video = stream as VideoStream
      const bits: string[] = [`${video.width}×${video.height}`]
      if (video.profile) bits.push(video.profile)
      if (video.level) bits.push(`L${formatLevel(video.level)}`)
      if (video.bitDepth && video.bitDepth > 8) bits.push(`${video.bitDepth}-bit`)
      if (video.chromaSubsampling && video.chromaSubsampling !== '4:2:0') bits.push(video.chromaSubsampling)
      if (video.frameRate) bits.push(`${video.frameRate.toFixed(3).replace(/\.?0+$/, '')} fps`)
      if (video.isInterlaced) bits.push('interlaced')
      if (video.dolbyVisionProfile != null) bits.push(`Dolby Vision ${video.dolbyVisionProfile}`)
      else if (video.isHdr) bits.push('HDR')
      if (video.codecTag) bits.push(video.codecTag)
      return bits.join(' · ')
    }
    case 'audio': {
      const audio = stream as AudioStream
      const bits: string[] = []
      if (audio.profile) bits.push(audio.profile)
      bits.push(audio.channelLayout ?? `${audio.channels}ch`)
      if (audio.sampleRate) bits.push(`${(audio.sampleRate / 1000).toFixed(audio.sampleRate % 1000 === 0 ? 0 : 1)} kHz`)
      if (audio.bitRate) bits.push(formatBitrate(audio.bitRate))
      return bits.join(' · ')
    }
    case 'subtitle': {
      const subtitle = stream as SubtitleStream
      return subtitle.isImageBased ? 'image-based (burn-in required)' : 'text'
    }
    default:
      return stream.codecLongName ?? ''
  }
}

function Flags({ stream }: { stream: MediaStream }): React.JSX.Element | null {
  const flags: { label: string; tone: string }[] = []
  if (stream.disposition.default) flags.push({ label: 'default', tone: 'info' })
  if (stream.disposition.forced) flags.push({ label: 'forced', tone: 'neutral' })
  if (stream.disposition.commentary) flags.push({ label: 'commentary', tone: 'neutral' })
  if (stream.disposition.hearingImpaired) flags.push({ label: 'SDH', tone: 'neutral' })
  if (stream.disposition.visualImpaired) flags.push({ label: 'AD', tone: 'neutral' })
  if (flags.length === 0) return null
  return (
    <span className="flags">
      {flags.map((flag) => (
        <span key={flag.label} className={`badge ${flag.tone}`}>
          {flag.label}
        </span>
      ))}
    </span>
  )
}

export default function StreamTable({ result }: { result: AnalysisResult }): React.JSX.Element {
  const streams = result.file.streams.filter((s) => s.kind !== 'data')
  const changes = result.plan.trackChanges

  return (
    <table className="streams">
      <thead>
        <tr>
          <th style={{ width: 40 }}>#</th>
          <th style={{ width: 80 }}>Type</th>
          <th style={{ width: 110 }}>Codec</th>
          <th style={{ width: 110 }}>Language</th>
          <th>Details</th>
          <th style={{ width: 200 }}>Flags</th>
          <th style={{ width: 230 }}>Planned change</th>
        </tr>
      </thead>
      <tbody>
        {streams.map((stream) => {
          const applicable = changes.filter((c) => c.streamIndex === stream.index)
          return (
            <tr key={stream.index}>
              <td className="mono">{stream.index}</td>
              <td>{stream.kind}</td>
              <td className="nowrap">{stream.codec}</td>
              <td className="nowrap">
                {languageName(stream.language)}
                {stream.rawLanguage && stream.rawLanguage.toLowerCase() !== stream.language ? (
                  <span className="muted"> ({stream.rawLanguage})</span>
                ) : null}
              </td>
              <td>
                {describe(stream)}
                {stream.title ? <div className="muted">“{stream.title}”</div> : null}
              </td>
              <td>
                <Flags stream={stream} />
              </td>
              <td className="muted">
                {applicable.length === 0
                  ? '—'
                  : applicable.map((change, index) => <div key={index}>{change.reason}</div>)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
