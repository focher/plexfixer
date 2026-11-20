/**
 * Correcting an H.264 level label, where the label is the only thing wrong.
 */

import type { RepairModule } from '../framework.js'
import { formatLevel } from '../../rules.js'

export const relabelH264Level: RepairModule = {
  id: 'repair.relabel-h264-level',
  title: 'Relabel the H.264 level',
  summary: 'Corrects an over-stated level without re-encoding anything',
  whatItDoes:
    'Rewrites the level number an H.264 stream claims, when the claim is higher than the stream actually ' +
    'needs. Encoders over-state this constantly. The cost of the lie is real — a client that caps at Level ' +
    '4.1 refuses a file labelled 4.2 without ever looking at what is inside it — and the fix is free.',
  howItWorks:
    'Only ever runs when the level check has already proved the stream fits inside the lower level: its ' +
    'resolution, frame rate, reference frames and bitrate all checked against that level’s limits. The ' +
    'file is rewritten with the streams copied and the new number written in. If the stream is being ' +
    're-encoded anyway, this does nothing — the encoder sets the level itself.',
  ifDisabled:
    'Streams keep their over-stated level, and the clients that cap below it keep refusing them, even though ' +
    'correcting the label would have cost nothing.',
  answers: ['video-level-too-high'],

  run({ video, state }) {
    // A relabel only applies when the video is copied; a re-encode sets the
    // level itself.
    if (state.needsTranscode || state.relabelLevel == null) return {}

    const level = video[0]?.level
    return {
      strategy: 'remux',
      plan: { videoLevel: state.relabelLevel },
      remuxParts:
        level != null
          ? [`relabel H.264 Level ${formatLevel(level)} as ${formatLevel(state.relabelLevel)}`]
          : []
    }
  }
}
