/**
 * More reference frames than a hardware decoder budgets for.
 */

import type { CheckModule } from '../framework.js'

export const videoRefFrames: CheckModule = {
  id: 'check.video-ref-frames',
  title: 'Reference frames',
  summary: 'More reference frames at HD than some decoders budget for',
  whatItDoes:
    'Finds HD video encoded with more reference frames than some television and streaming-box decoders are ' +
    'built to hold. Encoders use reference frames to squeeze the file smaller; decoders have a fixed amount of ' +
    'memory for them that shrinks as resolution grows, and past that point they stutter or refuse.',
  howItWorks:
    'Flags more than four reference frames at 720p or above. Below HD there is enough headroom that it does ' +
    'not matter. Reported for information: it is a real compatibility risk on some devices and harmless on ' +
    'most, so it is not worth a re-encode on its own.',
  ifDisabled:
    'Nothing is said about reference frames. Files that stutter on an older TV will look healthy here.',
  raises: ['video-refframes-high'],

  run({ video }) {
    const stream = video[0]
    if (!stream || stream.refFrames == null || stream.refFrames <= 4 || stream.height < 720) return {}

    return {
      findings: [
        {
          code: 'video-refframes-high',
          severity: 'info',
          remedy: 'transcode',
          title: `${stream.refFrames} reference frames at ${stream.height}p`,
          detail:
            'Hardware decoders have a reference-frame budget that scales down with resolution. More than 4 at HD ' +
            'resolutions trips up some TV and streaming-box decoders.',
          streamIndexes: [stream.index]
        }
      ]
    }
  }
}
