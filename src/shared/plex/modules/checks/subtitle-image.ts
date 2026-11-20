/**
 * Image subtitles, which Plex burns into the picture.
 */

import type { CheckModule } from '../framework.js'
import { isImageSubtitle } from '../../rules.js'

export const subtitleImage: CheckModule = {
  id: 'check.subtitle-image',
  title: 'Image subtitles',
  summary: 'PGS and VobSub tracks, which force a transcode whenever selected',
  whatItDoes:
    'Finds subtitle tracks that are pictures rather than text — the kind Blu-rays and DVDs carry. A client ' +
    'cannot restyle or reposition a picture, so Plex paints it into the video itself, and painting anything ' +
    'into the video means re-encoding the video. A file that would have played untouched suddenly transcodes.',
  howItWorks:
    'Identifies tracks in the picture-based subtitle formats (PGS from Blu-ray, VobSub from DVD). They are ' +
    'harmless while nobody selects them, which is why this is a warning rather than a blocker — but they are ' +
    'one click away from costing a transcode. When the file is headed for MP4 and "Drop image subtitles" is on ' +
    'under Compatibility, they are left out of the repaired file.',
  ifDisabled:
    'Image subtitle tracks are not mentioned and never dropped, so the burn-in transcode stays one selection ' +
    'away.',
  raises: ['subtitle-image-based'],

  run({ subtitles, settings, state }) {
    const imageBased = subtitles.filter((s) => isImageSubtitle(s.codec))
    if (imageBased.length === 0) return {}

    const targetContainer = state.targetContainer
    const dropping = targetContainer === 'mp4' && settings.dropImageSubtitlesOnMp4

    return {
      signals: dropping ? { dropStreams: imageBased.map((s) => s.index) } : undefined,
      findings: [
        {
          code: 'subtitle-image-based',
          severity: 'warning',
          remedy: targetContainer === 'mp4' ? 'lossless' : 'manual',
          title: `${imageBased.length} image-based subtitle track${imageBased.length === 1 ? '' : 's'} (PGS/VobSub)`,
          detail:
            'Image subtitles cannot be rendered as text by Plex clients. Any time one is selected, Plex burns it ' +
            'into the picture — a full video transcode, even for a file that would otherwise direct play. They are ' +
            'harmless while unselected, but risky to leave in place.',
          streamIndexes: imageBased.map((s) => s.index)
        }
      ]
    }
  }
}
