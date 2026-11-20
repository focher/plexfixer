/**
 * Leaving behind the subtitle tracks that cannot make the journey.
 */

import type { RepairModule } from '../framework.js'
import type { TrackPlanChange } from '../../../types.js'

export const dropUnstorableSubtitles: RepairModule = {
  id: 'repair.drop-unstorable-subtitles',
  title: 'Drop subtitles MP4 cannot hold',
  summary: 'Leaves out the tracks the target container has nowhere to put',
  whatItDoes:
    'Leaves out the subtitle tracks that cannot travel into the file being written — the ones MP4 has no ' +
    'place for, and the image-based ones when you have chosen not to carry those into an MP4.',
  howItWorks:
    'Acts on what the subtitle checks concluded. Each track being left behind is listed by name in the plan ' +
    'before anything is written, so this is never a surprise. Turning on "Extract text subtitles" under ' +
    'Compatibility writes the text ones out as sidecar files first, which means nothing is actually lost.',
  ifDisabled:
    'The repair will try to carry every subtitle track into the output. Into an MP4 that simply will not ' +
    'work, and ffmpeg will refuse the track or the file.',
  answers: ['subtitle-unsupported-in-mp4', 'subtitle-image-based'],

  run({ subtitles, state }) {
    if (state.dropStreams.length === 0) return {}

    const byIndex = new Map(subtitles.map((s) => [s.index, s]))
    const trackChanges: TrackPlanChange[] = []
    for (const index of state.dropStreams) {
      const stream = byIndex.get(index)
      if (!stream) continue
      trackChanges.push({
        streamIndex: stream.index,
        kind: 'subtitle',
        drop: true,
        reason: `${stream.codec.toUpperCase()} cannot be stored in MP4`
      })
    }

    return trackChanges.length > 0 ? { trackChanges } : {}
  }
}
