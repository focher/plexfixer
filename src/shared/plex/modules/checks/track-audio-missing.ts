/**
 * A file with no audio at all.
 */

import type { CheckModule } from '../framework.js'

export const trackAudioMissing: CheckModule = {
  id: 'check.track-audio-missing',
  title: 'No audio track',
  summary: 'Files with no sound, which most clients refuse outright',
  whatItDoes:
    'Reports a file that has no audio track. Most Plex clients either refuse it or play it in silence, and ' +
    'neither is what anyone expects from a film.',
  howItWorks:
    'Counts the audio tracks. There is nothing to repair — audio cannot be invented — so this is reported and ' +
    'left to you.',
  ifDisabled:
    'Silent files are not mentioned.',
  raises: ['audio-missing'],

  run({ audio }) {
    if (audio.length > 0) return {}

    return {
      findings: [
        {
          code: 'audio-missing',
          severity: 'blocker',
          remedy: 'manual',
          title: 'No audio track',
          detail: 'The file has no audio stream. Most Plex clients will refuse to play it or play it silently.'
        }
      ]
    }
  }
}
