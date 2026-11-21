/**
 * ASS/SSA subtitles, whose styling clients cannot reproduce.
 */

import type { CheckModule } from '../framework.js'
import { STYLED_SUBTITLE_CODECS } from '../../rules.js'

export const subtitleStyled: CheckModule = {
  id: 'check.subtitle-styled',
  title: 'Styled subtitles',
  summary: 'ASS/SSA tracks, which Plex burns in rather than converting',
  whatItDoes:
    'Finds subtitle tracks in the styled formats — ASS and SSA — which carry fonts, positioning, colours and ' +
    'karaoke timing on top of the words. Anime fansubs are full of them. Clients cannot reproduce any of that, ' +
    'so Plex paints them into the picture instead, which re-encodes the video.',
  howItWorks:
    'Identifies tracks in the styled subtitle formats. The fix is not to delete them but to write a plain text ' +
    'sidecar file beside the video with the same dialogue in it: clients render a sidecar as text, which costs ' +
    'nothing, and the original styled track stays where it is.',
  ifDisabled:
    'Styled subtitle tracks are not mentioned and no plain-text sidecar is written for them.',
  raises: ['subtitle-styled-ass'],

  run({ subtitles }) {
    const styled = subtitles.filter((s) => STYLED_SUBTITLE_CODECS.has(s.codec.toLowerCase()))
    if (styled.length === 0) return {}

    return {
      findings: [
        {
          code: 'subtitle-styled-ass',
          severity: 'info',
          remedy: 'lossless',
          title: `${styled.length} styled subtitle track${styled.length === 1 ? '' : 's'} (ASS/SSA)`,
          detail:
            'ASS/SSA carries positioning, fonts and karaoke effects that clients cannot reproduce, so Plex burns ' +
            'these in rather than converting them. Extracting a plain .srt sidecar gives clients a track they can ' +
            'render without transcoding.',
          streamIndexes: styled.map((s) => s.index)
        }
      ]
    }
  }
}
