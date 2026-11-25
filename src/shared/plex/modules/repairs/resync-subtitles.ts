/**
 * Correcting subtitle timing against the audio, in the pass that is already
 * rewriting the file.
 */

import type { RepairModule } from '../framework.js'
import { isTextSubtitle } from '../../rules.js'
import type { TrackPlanChange } from '../../../types.js'

export const resyncSubtitles: RepairModule = {
  id: 'repair.resync-subtitles',
  title: 'Resync subtitles to the audio',
  summary: 'Measures each text subtitle against the speech and corrects what is out of step',
  whatItDoes:
    'Finds where the speech actually is in the audio, compares it with where each text subtitle says the lines ' +
    'are, and shifts — or stretches, for the ones converted between film and PAL frame rates — whatever is out ' +
    'of step. The corrected timings are written into the track as the file is rewritten.',
  howItWorks:
    'With "Resync subtitles during a repair" on under Compatibility, every text subtitle track in the file is ' +
    'measured. A track a rule you wrote asked for is measured whether that setting is on or not — you asked. ' +
    'The measurement runs during the repair rather than during analysis because it reads the whole audio track, ' +
    'which takes twenty seconds to a minute on a feature film; a track that turns out to be in step is left ' +
    'exactly as it was. Picture subtitles are never measured: there are no cue times in them to compare.',
  ifDisabled:
    'Subtitle timings are carried across as they are. A track that is out of step stays out of step until it is ' +
    'resynced by hand from the Subtitles panel.',
  answers: ['custom'],

  run({ subtitles, settings, state }) {
    const dropped = new Set(state.dropStreams)
    const asked = new Set(state.resyncSubtitles.map((stream) => stream.index))

    const wanted = subtitles.filter((stream) => {
      // There are no cue times in a picture subtitle to measure.
      if (!isTextSubtitle(stream.codec)) return false
      if (dropped.has(stream.index)) return false
      return asked.has(stream.index) || settings.resyncSubtitlesOnRepair
    })
    if (wanted.length === 0) return {}

    const trackChanges: TrackPlanChange[] = wanted.map((stream) => ({
      streamIndex: stream.index,
      kind: 'subtitle',
      resync: true,
      reason: 'Timing measured against the audio and corrected if it is out of step'
    }))

    return {
      trackChanges,
      plan: { resyncSubtitles: wanted.map((stream) => stream.index) },
      actions: [
        {
          label: `Check the timing of ${wanted.length} subtitle track${wanted.length === 1 ? '' : 's'} against the audio`,
          detail:
            'Finding the speech reads the whole audio track, so this adds time to the repair whether or not ' +
            'anything turns out to need moving. A track already in step is written out unchanged.'
        }
      ]
    }
  }
}
