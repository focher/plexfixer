/**
 * The tracks in a file, and what can be done to the subtitle ones.
 *
 * It replaced a seven-column table, and two of those columns are worth saying
 * goodbye to properly.
 *
 * **Flags** carried a row of badges, of which `default` was on almost every
 * file and said the least: every film has a default audio track, so the badge
 * was noise everywhere and information nowhere. It is now a tick in a column
 * of its own at the left, where "which one plays" can be answered by looking
 * down rather than by reading.
 *
 * **Planned change** repeated, per track, what the repair was going to do —
 * inside a panel you had to open to see it. Those lines now sit in the list's
 * own Proposed action column, where they are visible before you commit to
 * anything, which is when they matter.
 *
 * What the subtitle rows gain is the two things anybody opens this panel to
 * do: put a track back in time with the audio, and translate one. Both act on
 * the track in the file and write the result back into it.
 */

import { useState } from 'react'
import type { AnalysisResult, AppSettings, AudioStream, MediaStream, SubtitleStream, VideoStream } from '@shared/types.js'
import { languageName } from '@shared/languages.js'
import { translationTargets } from '@shared/subtitles/models.js'
import { formatLevel, isTextSubtitle } from '@shared/plex/rules.js'
import { formatBitrate } from '../format.js'
import { CheckIcon, PlusIcon, SyncIcon, TranslateIcon } from './icons.js'

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
      return bits.join(' · ')
    }
    case 'audio': {
      const audio = stream as AudioStream
      const bits: string[] = []
      if (audio.profile) bits.push(audio.profile)
      bits.push(audio.channelLayout ?? `${audio.channels}ch`)
      if (audio.bitRate) bits.push(formatBitrate(audio.bitRate))
      return bits.join(' · ')
    }
    case 'subtitle': {
      // A subtitle's format is not something to decide about here. `subrip`
      // against `ass` against `hdmv_pgs_subtitle` is a fact about how the
      // words are stored, and what to do about a format Plex cannot use is
      // already decided and shown as a line in Proposed action — so repeating
      // it here is a column of jargon that answers a question nobody is
      // asking of this panel.
      //
      // Picture subtitles keep one word, because it is the reason the row has
      // no buttons on it: there is no text in them to retime or translate.
      const subtitle = stream as SubtitleStream
      return subtitle.isImageBased ? 'picture' : ''
    }
    default:
      return stream.codecLongName ?? ''
  }
}

/** The flags worth naming once `default` has become a tick. */
function otherFlags(stream: MediaStream): string[] {
  const flags: string[] = []
  if (stream.disposition.forced) flags.push('forced')
  if (stream.disposition.commentary) flags.push('commentary')
  if (stream.disposition.hearingImpaired) flags.push('SDH')
  if (stream.disposition.visualImpaired) flags.push('AD')
  return flags
}

export interface TrackListProps {
  result: AnalysisResult
  settings: AppSettings
  /** Retime this subtitle against the audio and write it back into the film. */
  onResync?: (streamIndex: number) => void
  /** Translate this subtitle into `language` and add it to the film. */
  onTranslate?: (streamIndex: number, language: string) => void
  /** Open the panel that finds one online or writes one from the audio. */
  onAddSubtitle?: () => void
  /** Stream indexes with something running on them. */
  busy?: Set<number>
}

export default function TrackList(props: TrackListProps): React.JSX.Element {
  const streams = props.result.file.streams.filter((stream) => stream.kind !== 'data')
  return (
    <div className="tracks">
      {streams.map((stream) => (
        <TrackRow
          key={stream.index}
          stream={stream}
          languages={translationTargets(
            stream.language,
            props.settings.preferredSubtitleLanguage,
            props.settings.subtitleSearchLanguages ?? []
          )}
          busy={props.busy?.has(stream.index) ?? false}
          onResync={props.onResync}
          onTranslate={props.onTranslate}
        />
      ))}

      <button className="track-add" onClick={props.onAddSubtitle} disabled={!props.onAddSubtitle}>
        <PlusIcon />
        Add a subtitle track
      </button>
    </div>
  )
}

function TrackRow({
  stream,
  languages,
  busy,
  onResync,
  onTranslate
}: {
  stream: MediaStream
  languages: string[]
  busy: boolean
  onResync?: (streamIndex: number) => void
  onTranslate?: (streamIndex: number, language: string) => void
}): React.JSX.Element {
  // Already narrowed to this track: see `translationTargets`.
  const options = languages

  /*
   * The choice is derived rather than stored, and only remembered once it is
   * made. `useState(languages[0])` read the list on the first render and never
   * looked again, so a language added in Settings never appeared, and a list
   * that arrived empty left the selection stuck on nothing for ever.
   */
  const [chosen, setChosen] = useState<string>()
  const target = chosen && options.includes(chosen) ? chosen : (options[0] ?? '')

  const flags = otherFlags(stream)
  // Only a text subtitle can be measured against speech or translated: there
  // are no words in a picture of words to work with.
  const actionable = stream.kind === 'subtitle' && isTextSubtitle(stream.codec)

  return (
    <div className={`track${busy ? ' busy' : ''}`}>
      {/* The facts travel together, so they wrap as one and the controls stay
          whole rather than being cut off by a narrow panel. */}
      <span className="track-facts">
        <span className="track-default" title={stream.disposition.default ? 'Plays without being chosen' : undefined}>
          {stream.disposition.default ? <CheckIcon /> : null}
        </span>
        <span className="track-kind">{stream.kind}</span>
        {stream.kind === 'subtitle' ? null : <span className="track-codec">{stream.codec}</span>}
        <span className="track-language">{languageName(stream.language)}</span>
        <span className="track-detail">
          {describe(stream)}
          {stream.title ? <span className="track-title">“{stream.title}”</span> : null}
          {flags.length > 0 ? <span className="track-flags">{flags.join(' · ')}</span> : null}
        </span>
      </span>

      <span className="track-actions">
        {actionable ? (
          <>
            <button
              className="icon-button"
              disabled={busy || !onResync}
              onClick={() => onResync?.(stream.index)}
              aria-label={`Resync track ${stream.index} to the audio`}
              title="Put this track back in time with the audio"
            >
              <SyncIcon />
            </button>
            <span className="track-translate">
              {/*
                With nothing to offer, the picker is left out rather than
                rendered with one dead entry in it, and the button says where
                to add languages. A control that opens on a single choice reads
                as broken, and it was.
              */}
              {options.length > 0 ? (
                <select
                  value={target}
                  disabled={busy}
                  aria-label={`Language to translate track ${stream.index} into`}
                  onChange={(event) => setChosen(event.target.value)}
                >
                  {options.map((language) => (
                    <option key={language} value={language}>
                      {languageName(language)}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                className="icon-button"
                disabled={busy || !onTranslate || !target}
                onClick={() => onTranslate?.(stream.index, target)}
                aria-label={`Translate track ${stream.index}`}
                title={
                  target
                    ? `Translate this track into ${languageName(target)} and add it to the film`
                    : 'Add the languages you want under Settings → Subtitles → Also look for'
                }
              >
                <TranslateIcon />
              </button>
            </span>
          </>
        ) : null}
      </span>
    </div>
  )
}
