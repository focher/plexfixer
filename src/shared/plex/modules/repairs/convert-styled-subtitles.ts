/**
 * Rewriting a styled subtitle track as plain text, inside the file.
 */

import type { RepairModule } from '../framework.js'
import { STYLED_SUBTITLE_CODECS } from '../../rules.js'
import type { TrackPlanChange } from '../../../types.js'

export const convertStyledSubtitles: RepairModule = {
  id: 'repair.convert-styled-subtitles',
  title: 'Rewrite styled subtitles as plain text',
  summary: 'Turns ASS/SSA into SRT in the file, so clients render it for free',
  whatItDoes:
    'Rewrites ASS and SSA subtitle tracks as plain SRT without leaving the file. The dialogue is identical; ' +
    'what goes is the styling — fonts, positions, colours, karaoke timing — which no Plex client can reproduce ' +
    'anyway and which is the entire reason Plex paints these tracks into the picture instead of sending them.',
  howItWorks:
    'Every ASS or SSA track is marked to be written as SRT on the way through. It costs nothing: the subtitle ' +
    'is decoded to text and re-encoded while the rest of the file is copied, so a repair that was already a ' +
    'stream copy stays one. A file headed for MP4 needs no help here — tx3g is a text format, so the styling ' +
    'is dropped by the container change itself.',
  ifDisabled:
    'Styled tracks are carried across untouched, and Plex goes on burning them into the picture rather than ' +
    'sending text a client could draw.',
  answers: ['subtitle-styled-ass'],

  run({ subtitles, state }) {
    // Into MP4 every text subtitle becomes tx3g regardless, and tx3g has no
    // styling to carry — so saying it again here would only add a line to the
    // plan for something the container change already does.
    if (state.targetContainer === 'mp4') return {}

    const dropped = new Set(state.dropStreams)
    const styled = subtitles.filter(
      (stream) => STYLED_SUBTITLE_CODECS.has(stream.codec.toLowerCase()) && !dropped.has(stream.index)
    )
    if (styled.length === 0) return {}

    const trackChanges: TrackPlanChange[] = styled.map((stream) => ({
      streamIndex: stream.index,
      kind: 'subtitle',
      convertSubtitleTo: 'srt',
      reason: `${stream.codec.toUpperCase()} rewritten as SRT, which clients render without transcoding`
    }))

    return {
      trackChanges,
      actions: [
        {
          label: `Rewrite ${styled.length} styled subtitle track${styled.length === 1 ? '' : 's'} as SRT`,
          detail:
            'The words are kept and the styling is dropped. Plex sends plain text to the client instead of ' +
            'burning the track into the video.'
        }
      ]
    }
  }
}
