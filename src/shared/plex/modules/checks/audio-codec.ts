/**
 * Whether each audio track is one clients can decode.
 */

import type { CheckModule } from '../framework.js'
import { MAX_SAFE_CHANNELS, audioCodecTier } from '../../rules.js'
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
    'essentially nothing (the lossless and legacy formats). The first two pass; the rest are reported — but ' +
    'only when nothing beside them can be played. A TrueHD track sitting next to an AAC one is not a ' +
    'problem; it is a disc rip with its soundtrack kept and a companion track added, which is the state a ' +
    'repair leaves a file in, and saying otherwise would mean a file could never come out of a repair fixed.',
  ifDisabled:
    'Nothing is said about audio formats, so a library of disc rips will look healthy while the server ' +
    'converts the soundtrack for every play.',
  raises: ['audio-codec-unsupported', 'audio-codec-limited'],

  run({ audio }) {
    const findings: Finding[] = []
    const incompatibleAudio: AudioStream[] = []

    /*
     * The decisive question, asked here too.
     *
     * `check.audio-compatible-track` asks whether any one track plays
     * everywhere, and stops complaining as soon as one does. This check did
     * not, so a file repaired by adding an AAC track beside its DTS-HD MA came
     * back from the next scan with the DTS track still reported as a blocker —
     * the very remedy this finding recommends, applied, and the finding still
     * firing. The file could never reach "passed", and the repair would be
     * offered again for ever.
     *
     * So an exotic track is only a fault when nothing beside it can be played.
     * Where something can, the track is still named — the information is worth
     * having — but as a note, not a blocker, and it is kept out of
     * `incompatibleAudio`, which is what tells a repair there is audio work to
     * do.
     */
    const playableCompanion = audio.some(
      (stream) =>
        audioCodecTier(stream.codec, stream.profile) === 'universal' && stream.channels <= MAX_SAFE_CHANNELS
    )

    for (const stream of audio) {
      const tier = audioCodecTier(stream.codec, stream.profile)
      const label = stream.profile ? `${stream.codec.toUpperCase()} (${stream.profile})` : stream.codec.toUpperCase()

      if (tier !== 'none' && tier !== 'limited') continue

      if (playableCompanion) {
        findings.push({
          code: tier === 'none' ? 'audio-codec-unsupported' : 'audio-codec-limited',
          severity: 'info',
          remedy: 'lossless',
          title: `Audio track #${stream.index}: ${label}, kept alongside a compatible track`,
          detail:
            `${label} is not direct-playable, but this file already has a track every client can decode, so ` +
            'clients that cannot manage this one will pick that instead of making the server convert anything. ' +
            'The original is worth keeping: it is the better-sounding track for anything that can play it.',
          streamIndexes: [stream.index]
        })
        continue
      }

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
      } else {
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
