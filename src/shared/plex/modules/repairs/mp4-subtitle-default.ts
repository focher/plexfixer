/**
 * The repair that withdraws itself, because MP4 will not do what it promises.
 */

import type { RepairModule } from '../framework.js'
import { isImageSubtitle } from '../../rules.js'
import type { Finding, TrackPlanChange } from '../../../types.js'

export const mp4SubtitleDefault: RepairModule = {
  id: 'repair.mp4-subtitle-default',
  title: 'Subtitle defaults in MP4',
  summary: 'Withdraws a subtitle fix that MP4 would not actually carry out',
  whatItDoes:
    'Withdraws a repair rather than carrying one out. MP4 cannot express "no subtitle track is enabled": ' +
    'whatever the flags say, the muxer enables one. So clearing the last remaining default does not switch ' +
    'subtitles off — it hands the flag to whichever track happens to come first. On a file whose unwanted ' +
    'default is the English track, that promotes a language nobody asked for; on one where it is already ' +
    'first, it changes nothing at all. Either way the report promised something the file would not come back ' +
    'with.',
  howItWorks:
    'Runs only when the file is headed for MP4 and nothing is being promoted to default. The changes that ' +
    'would merely have cleared a flag are withdrawn, and the findings behind them are rewritten to say the ' +
    'fix belongs in the client’s own playback settings. Image subtitles are deliberately left out of ' +
    'this: clearing their default risks the same reshuffle, but the alternative is Plex burning them in and ' +
    'forcing a full transcode, which is worse than the wrong language coming up.',
  ifDisabled:
    'The app will list "clear the subtitle default" as a repair on MP4 files and then not deliver it, because ' +
    'the format will not let it.',
  answers: [],

  run({ file, subtitles, state }) {
    if (state.targetContainer !== 'mp4') return {}

    const promotes = state.trackChanges.some((c) => c.kind === 'subtitle' && c.setDefault === true)
    if (promotes) return {}

    const imageSubtitles = new Set(subtitles.filter((s) => isImageSubtitle(s.codec)).map((s) => s.index))
    void file

    return {
      amendTrackChanges: (changes: TrackPlanChange[]) => {
        const next = [...changes]
        for (let i = next.length - 1; i >= 0; i--) {
          const change = next[i]
          if (change.kind !== 'subtitle' || change.setDefault !== false) continue
          if (imageSubtitles.has(change.streamIndex)) continue
          // Drop the whole change only if clearing the flag was all it did.
          if (change.setForced == null && change.setLanguage == null && !change.drop) {
            next.splice(i, 1)
          } else {
            next[i] = { ...change, setDefault: undefined }
          }
        }
        return next
      },

      // Say so, rather than listing a repair that will not happen.
      amendFindings: (findings: Finding[]) =>
        findings.map((finding) => {
          if (finding.code !== 'default-subtitle-unwanted' && finding.code !== 'default-subtitle-language-mismatch') {
            return finding
          }
          if (finding.streamIndexes?.some((index) => imageSubtitles.has(index))) return finding
          return {
            ...finding,
            remedy: 'manual' as const,
            detail:
              `${finding.detail} MP4 always leaves one subtitle track enabled, so clearing this flag would ` +
              'only move it to another language rather than switch subtitles off. Turn subtitles off in the ' +
              "Plex client's own playback settings instead."
          }
        })
    }
  }
}
