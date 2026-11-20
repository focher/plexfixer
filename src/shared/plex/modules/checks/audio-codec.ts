/**
 * Whether each audio track is one clients can decode.
 */

import type { CheckModule } from '../framework.js'
import { audioCodecTier } from '../../rules.js'
import type { AudioStream, Finding } from '../../../types.js'

export const audioCodec: CheckModule = {
  id: 'check.audio-codec',
  title: 'Audio codec support',
  summary: 'Tracks in formats clients cannot decode, or only some of them can',
  whatItDoes:
    'Looks at every audio track and asks whether clients can play it. The usual culprits are the lossless ' +
    'formats a disc rip keeps — TrueHD, DTS-HD, FLAC — which sound wonderful and which streaming clients ' +
    'cannot decode, so the server converts them on every play.',
  howItWorks:
    'Each audio format sits in one of four groups: playable on everything (AAC), playable on nearly ' +
    'everything (AC-3, E-AC-3), playable on some (DTS, and others browsers refuse), and playable on ' +
    'essentially nothing (the lossless and legacy formats). The first two pass; the rest are reported.',
  ifDisabled:
    'Nothing is said about audio formats, so a library of disc rips will look healthy while the server ' +
    'converts the soundtrack for every play.',
  raises: ['audio-codec-unsupported', 'audio-codec-limited'],

  run({ audio }) {
    const findings: Finding[] = []
    const incompatibleAudio: AudioStream[] = []

    for (const stream of audio) {
      const tier = audioCodecTier(stream.codec, stream.profile)
      const label = stream.profile ? `${stream.codec.toUpperCase()} (${stream.profile})` : stream.codec.toUpperCase()

      if (tier === 'none') {
        incompatibleAudio.push(stream)
        findings.push({
          code: 'audio-codec-unsupported',
          severity: 'blocker',
          remedy: 'transcode',
          title: `Audio track #${stream.index}: ${label} is not direct-playable`,
          detail:
            `${label} is a lossless or legacy format that streaming clients cannot decode. Plex transcodes it on ` +
            'every play. Adding a compatible companion track keeps the original intact while giving every client ' +
            'something it can play directly.',
          streamIndexes: [stream.index]
        })
      } else if (tier === 'limited') {
        findings.push({
          code: 'audio-codec-limited',
          severity: 'warning',
          remedy: 'transcode',
          title: `Audio track #${stream.index}: ${label} has limited client support`,
          detail: `${label} direct plays on some clients but is transcoded on others, notably web browsers.`,
          streamIndexes: [stream.index]
        })
      }
    }

    if (findings.length === 0 && incompatibleAudio.length === 0) return {}
    return { findings, signals: { incompatibleAudio } }
  }
}
