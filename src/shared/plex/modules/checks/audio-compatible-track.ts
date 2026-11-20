/**
 * The decisive audio question: is there one track every client can play?
 */

import type { CheckModule } from '../framework.js'
import { MAX_SAFE_CHANNELS, audioCodecTier } from '../../rules.js'

export const audioCompatibleTrack: CheckModule = {
  id: 'check.audio-compatible-track',
  title: 'A track every client can play',
  summary: 'Whether any one audio track is playable everywhere',
  whatItDoes:
    'Asks the question that actually decides whether a file plays without the server working: is there at ' +
    'least one audio track that every client can decode? Individual tracks being exotic does not matter if ' +
    'one ordinary track sits beside them. Having none is what forces a transcode.',
  howItWorks:
    'Looks for a single track that is both in a format everything decodes and at 5.1 channels or fewer. If ' +
    'none exists, the file is flagged — and, when "Add an AAC track" is on under Compatibility, the repair ' +
    'adds one alongside the originals rather than replacing anything.',
  ifDisabled:
    'A file whose every audio track needs converting will not be flagged, and no companion track will be ' +
    'proposed for it.',
  raises: ['audio-no-compatible-track'],

  run({ audio, settings }) {
    if (audio.length === 0) return {}

    const hasUniversal = audio.some((s) => {
      const tier = audioCodecTier(s.codec, s.profile)
      return tier === 'universal' && s.channels <= MAX_SAFE_CHANNELS
    })
    if (hasUniversal) return {}

    return {
      signals: { needsCompatibilityAudio: settings.ensureAacStereo },
      findings: [
        {
          code: 'audio-no-compatible-track',
          severity: 'blocker',
          remedy: 'transcode',
          title: 'No universally compatible audio track',
          detail:
            'Not one audio track is AAC at 5.1 or below, so every client without a matching decoder transcodes ' +
            'audio. Adding an AAC track alongside the originals is cheap and fixes it for all of them.',
          streamIndexes: audio.map((s) => s.index)
        }
      ]
    }
  }
}
