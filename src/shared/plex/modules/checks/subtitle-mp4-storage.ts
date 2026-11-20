/**
 * Subtitle tracks MP4 has nowhere to put.
 */

import type { CheckModule } from '../framework.js'
import { canStreamCopyIntoMp4 } from '../../rules.js'

export const subtitleMp4Storage: CheckModule = {
  id: 'check.subtitle-mp4-storage',
  title: 'Subtitles MP4 cannot store',
  summary: 'Tracks that cannot travel into an MP4 and will be left out',
  whatItDoes:
    'Warns about subtitle tracks that cannot come along when a file is rewrapped as MP4. This is not a quality ' +
    'judgement on the tracks — it is that the MP4 format has exactly one subtitle format it can hold, and ' +
    'anything else has nowhere to go.',
  howItWorks:
    'Raised only when the file is headed for MP4. Every subtitle track is checked against what MP4 can store, ' +
    'and whatever cannot is named so you know what the repair will leave behind. Tracks already being dropped ' +
    'for another reason are not listed twice. Turning on "Extract text subtitles" under Compatibility writes ' +
    'the text ones out as sidecar files first, so nothing is actually lost.',
  ifDisabled:
    'Tracks MP4 cannot hold are still left out of an MP4 repair — the format has not changed — but you will ' +
    'not be told which ones before it happens.',
  raises: ['subtitle-unsupported-in-mp4'],

  run({ subtitles, state }) {
    if (state.targetContainer !== 'mp4') return {}

    const alreadyDropped = new Set(state.dropStreams)
    const unsupported = subtitles.filter((s) => !canStreamCopyIntoMp4('subtitle', s.codec))
    const notAlreadyDropped = unsupported.filter((s) => !alreadyDropped.has(s.index))
    if (notAlreadyDropped.length === 0) return {}

    return {
      signals: { dropStreams: notAlreadyDropped.map((s) => s.index) },
      findings: [
        {
          code: 'subtitle-unsupported-in-mp4',
          severity: 'warning',
          remedy: 'lossless',
          title: `${notAlreadyDropped.length} subtitle track${notAlreadyDropped.length === 1 ? '' : 's'} cannot be stored in MP4`,
          detail:
            'MP4 only holds tx3g (mov_text) subtitles. These tracks will be dropped from the MP4; extract them ' +
            'as sidecar files first if you want to keep them.',
          streamIndexes: notAlreadyDropped.map((s) => s.index)
        }
      ]
    }
  }
}
