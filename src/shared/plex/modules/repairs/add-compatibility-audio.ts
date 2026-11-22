/**
 * Adding one audio track every client can play, and keeping the originals.
 */

import { defineRepair } from '../framework.js'
import { audioCodecTier } from '../../rules.js'
import { languageName, normalizeLanguage } from '../../../languages.js'
import type { TrackPlanChange } from '../../../types.js'

export const addCompatibilityAudio = defineRepair({
  id: 'repair.add-compatibility-audio',
  title: 'Add a compatible audio track',
  summary: 'Adds an AAC track beside the originals, which are kept untouched',
  whatItDoes:
    'Adds one ordinary AAC audio track to a file whose every existing track needs converting. Nothing is ' +
    'replaced and nothing is thrown away — the lossless track a disc rip is valued for stays exactly where it ' +
    'is. The new track exists so that a client without a TrueHD or DTS-HD decoder has something it can simply ' +
    'play.',
  howItWorks:
    'The new track is derived from the audio a viewer would actually have heard — the track chosen as the ' +
    'default — so it comes out in the right language. Its channel count follows the source up to 5.1, and its ' +
    'bitrate follows the per-channel figure under Transcoding. It then becomes the default itself, and the ' +
    'original tracks give up the flag: two tracks both claiming to be the default is exactly the ambiguity ' +
    'this app exists to remove. Encoding one audio track is quick — the video is copied, not re-encoded.',
  ifDisabled:
    'Files whose every audio track needs converting are left that way, and the server keeps converting the ' +
    'soundtrack on every play.',
  answers: ['audio-no-compatible-track', 'audio-codec-unsupported', 'audio-codec-limited', 'audio-channels-high'],

  params: {
    maxChannels: {
      type: 'number',
      label: 'Most channels for the added track',
      help: 'The companion AAC track never has more channels than this.',
      min: 2,
      max: 8
    }
  },

  run({ audio, settings, state, params }) {
    // An incompatible track is a reason to encode audio even when no companion
    // track is being added.
    if (!state.needsCompatibilityAudio) {
      return state.incompatibleAudio.length > 0 ? { strategy: 'transcode-audio' } : {}
    }
    if (audio.length === 0) return {}

    // Derive the companion track from the audio the viewer would actually pick:
    // the one chosen as default, so the new track carries the right language.
    const chosen =
      audio.find((s) => s.index === state.defaultAudioIndex) ??
      audio.find((s) => audioCodecTier(s.codec, s.profile) !== 'universal') ??
      audio[0]
    const channels = Math.max(2, Math.min(chosen.channels || 2, params.maxChannels))
    const language = normalizeLanguage(
      state.trackChanges.find((c) => c.streamIndex === chosen.index && c.setLanguage)?.setLanguage ?? chosen.language
    )

    // The companion track takes over as the default, so every original audio
    // track must give the flag up — otherwise the output ships with two default
    // audio tracks.
    const trackChanges: TrackPlanChange[] = audio
      .filter((stream) => stream.disposition.default)
      .map((stream) => ({
        streamIndex: stream.index,
        kind: 'audio' as const,
        setDefault: false,
        reason: 'Superseded as default by the new AAC track'
      }))

    return {
      strategy: 'transcode-audio',
      // Every default flag the track modules worked out for the originals is
      // withdrawn first: the new track is the default now.
      amendTrackChanges: (changes) =>
        changes.filter((change) => !(change.kind === 'audio' && change.setDefault != null)),
      trackChanges,
      plan: {
        addCompatibilityAudio: {
          sourceStreamIndex: chosen.index,
          channels,
          language,
          bitrateKbps: channels * settings.aacBitratePerChannel
        }
      },
      actions: [
        {
          label: `Add an AAC ${channels > 2 ? `${channels}ch` : 'stereo'} audio track (${languageName(language)})`,
          detail:
            'The original audio tracks are kept untouched. The new AAC track becomes the default so every client ' +
            'has something it can play without transcoding.'
        }
      ]
    }
  }
})
