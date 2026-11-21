/**
 * Saying when embedded artwork cannot come along.
 */

import type { RepairModule } from '../framework.js'
import { coverArtStreams } from '../../tracks.js'

export const dropCoverArt: RepairModule = {
  id: 'repair.drop-cover-art',
  title: 'Embedded cover art',
  summary: 'Says when a poster inside the file cannot travel into an MKV',
  whatItDoes:
    'Reports that embedded artwork is being left behind, when it is. Artwork survives a repair into MP4 ' +
    'perfectly well and there is nothing to say about it; Matroska has no way to mark a still image as cover ' +
    'art, so carrying it would turn the poster into a second video track — which is worse than leaving it ' +
    'out. Plex reads artwork from its own metadata anyway.',
  howItWorks:
    'Runs last, once the plan is settled, because it is a consequence of the file being rewritten rather than ' +
    'a reason to rewrite it. Nothing flags artwork on its own: a poster is not a direct-play problem, and ' +
    'proposing a rewrite just to strip one would be worse than leaving it alone.',
  ifDisabled:
    'Artwork is still left out of a Matroska output — the format has not changed — but the plan will not ' +
    'mention it.',
  answers: [],
  when: 'afterPlan',

  run({ file, state, strategy }) {
    const coverArt = coverArtStreams(file)
    if (coverArt.length === 0 || strategy === 'none' || state.targetContainer === 'mp4') return {}

    return {
      actions: [
        {
          label: `Drop ${coverArt.length} embedded cover-art track${coverArt.length === 1 ? '' : 's'}`,
          detail:
            'Matroska cannot mark a still image as cover art, so it would become a ' +
            'second video track and confuse client track pickers.'
        }
      ]
    }
  }
}
