/**
 * Re-encoding the audio tracks that cannot be played, in place of themselves.
 */

import type { RepairModule } from '../framework.js'
import { MAX_SAFE_CHANNELS } from '../../rules.js'
import type { AudioReplacementSpec } from '../../../types.js'

export const replaceIncompatibleAudio: RepairModule = {
  id: 'repair.replace-incompatible-audio',
  title: 'Replace incompatible audio',
  summary: 'Re-encodes the unplayable audio tracks as AAC, in place of themselves',
  whatItDoes:
    'Re-encodes each audio track no client can decode into ordinary AAC, keeping it in the same place in the ' +
    'file under the same language and name. Nothing is added and nothing is left beside it: where "Add an AAC ' +
    'track" gives a file two tracks, this gives it one that works. It is the right choice for a library kept ' +
    'small, and the wrong one for a disc rip whose lossless track is the point of having it — that track is ' +
    'gone once this runs.',
  howItWorks:
    'Only the named tracks are encoded. The video is copied, every other audio track is copied, and the ' +
    'subtitles are copied, so the cost is one audio encode and a file copy rather than anything resembling a ' +
    'transcode. Channel count follows the source up to 5.1, and bitrate follows the per-channel figure under ' +
    'Transcoding. A track that is merely exotic is left alone: this only touches the ones that made the file ' +
    'unplayable, which is what keeps it to the minimum work that produces a file every client can play.',
  ifDisabled:
    'Nothing is re-encoded in place. A file whose every audio track needs converting keeps them, and the ' +
    'findings stay on the report as unresolved.',
  answers: ['audio-no-compatible-track', 'audio-codec-unsupported', 'audio-codec-limited', 'audio-channels-high'],

  run({ settings, state }) {
    if (!state.needsAudioReplacement) return {}
    if (state.incompatibleAudio.length === 0) return {}

    const replaceAudio: AudioReplacementSpec[] = state.incompatibleAudio.map((stream) => {
      const channels = Math.max(2, Math.min(stream.channels || 2, MAX_SAFE_CHANNELS))
      return {
        sourceStreamIndex: stream.index,
        channels,
        bitrateKbps: channels * settings.aacBitratePerChannel
      }
    })

    const count = replaceAudio.length
    return {
      strategy: 'transcode-audio',
      plan: { replaceAudio },
      actions: [
        {
          label: `Re-encode ${count} audio track${count === 1 ? '' : 's'} as AAC`,
          detail:
            `${count === 1 ? 'The track' : 'Each track'} is replaced by an AAC version of itself, keeping its ` +
            'language, its name and its place in the file. The original audio is not kept — that is what ' +
            'replacing means, and why the other setting exists. The video is copied, not re-encoded.'
        }
      ]
    }
  }
}
