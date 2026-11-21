/**
 * Keeping only the video track that is the film.
 */

import type { RepairModule } from '../framework.js'
import type { TrackPlanChange } from '../../../types.js'

export const dropExtraVideo: RepairModule = {
  id: 'repair.drop-extra-video',
  title: 'Drop extra video tracks',
  summary: 'Keeps the first video track and leaves the rest out',
  whatItDoes:
    'Leaves out every video track after the first. A file is meant to have one; the extras are usually the ' +
    'wreckage of a merge, and they confuse both client decoders and Plex’s own matching.',
  howItWorks:
    'Keeps the first video track and drops the others. Embedded artwork is not touched by this — a poster ' +
    'looks like a video track to anything reading the file, and it is handled separately.',
  ifDisabled:
    'Extra video tracks are carried into the repaired file, and whatever they were confusing stays confused.',
  answers: ['video-multiple'],

  run({ video }) {
    if (video.length <= 1) return {}

    const trackChanges: TrackPlanChange[] = video.slice(1).map((stream) => ({
      streamIndex: stream.index,
      kind: 'video' as const,
      drop: true,
      reason: 'Secondary video track'
    }))

    return { trackChanges }
  }
}
