/**
 * Non-square pixels, which some clients get wrong.
 */

import type { CheckModule } from '../framework.js'

export const videoAnamorphic: CheckModule = {
  id: 'check.video-anamorphic',
  title: 'Anamorphic video',
  summary: 'Non-square pixels that some clients stretch wrongly',
  whatItDoes:
    'Finds video stored with non-square pixels, where the picture is meant to be stretched to its real shape ' +
    'at playback. Done right it is invisible; the problem is the clients that ignore the instruction and show ' +
    'everybody too thin or too wide.',
  howItWorks:
    'Reads the sample aspect ratio. Anything other than 1:1 means the stored picture is not the shape it is ' +
    'meant to be seen at. This is reported for information only — it is not worth re-encoding a film over, so ' +
    'nothing is proposed unless the file is being re-encoded anyway.',
  ifDisabled:
    'Nothing is said about anamorphic files, which is a small loss: this one is a note, not a problem.',
  raises: ['video-anamorphic'],

  run({ video }) {
    const stream = video[0]
    if (!stream?.isAnamorphic) return {}

    return {
      findings: [
        {
          code: 'video-anamorphic',
          severity: 'info',
          remedy: 'transcode',
          title: `Anamorphic video (sample aspect ratio ${stream.sampleAspectRatio})`,
          detail:
            'Non-square pixels are stretched at playback. Some clients ignore the aspect ratio metadata and show ' +
            'the picture with the wrong geometry.',
          streamIndexes: [stream.index]
        }
      ]
    }
  }
}
