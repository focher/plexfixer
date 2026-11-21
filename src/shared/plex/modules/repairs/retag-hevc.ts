/**
 * Changing four letters so Apple clients will open the file.
 */

import type { RepairModule } from '../framework.js'

export const retagHevc: RepairModule = {
  id: 'repair.retag-hevc',
  title: 'Retag HEVC for Apple clients',
  summary: 'Rewrites the codec tag from hev1 to hvc1 — metadata only',
  whatItDoes:
    'Changes the four-letter tag on an HEVC video track in an MP4 from the form Apple clients refuse to the ' +
    'form they accept. It is the smallest repair in the app and one of the most dramatic: a file that would ' +
    'not open at all on an iPhone or an Apple TV opens and direct plays afterwards.',
  howItWorks:
    'The file is rewritten with every stream copied and the tag written differently — not one frame is ' +
    're-encoded. A Dolby Vision stream gets the Dolby Vision form of the tag, so it stays Dolby Vision rather ' +
    'than being presented as ordinary HEVC.',
  ifDisabled:
    'HEVC MP4s carrying the wrong tag stay unplayable on Apple devices.',
  answers: ['video-hevc-wrong-tag'],

  run({ state }) {
    if (!state.needsTagFix) return {}
    return { strategy: 'remux', remuxParts: ['retag HEVC as hvc1'] }
  }
}
