/**
 * Adding one audio track every client can play, and keeping the originals.
 */

import type { RepairModule } from '../framework.js'
import { MAX_SAFE_CHANNELS, audioCodecTier } from '../../rules.js'
import { languageName, normalizeLanguage } from '../../../languages.js'
import type { TrackPlanChange } from '../../../types.js'

export const addCompatibilityAudio: RepairModule = {
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
    'soundtrack on every play. The findings stay on the report as unresolved, because they are.',
  answers: ['audio-no-compatible-track', 'audio-codec-unsupported', 'audio-codec-limited', 'audio-channels-high'],

  run({ audio, settings, state }) {
    /*
     * This module used to answer `{ strategy: 'transcode-audio' }` here when
     * the setting was off but the file had incompatible audio — on the theory
     * that an incompatible track is a reason to encode audio whether or not a
     * companion is added. Nothing then encoded anything: the strategy is what
     * `unresolvedFindings` reads to decide the audio blockers are handled, and
     * what `costNote` reads to bill for "one audio encode", but the ffmpeg
     * arguments come from the *plan*, and the plan was empty. So a DTS-HD-only
     * rip with the setting off reported both its blockers as resolved, ran a
     * plain remux, and came back from the next scan with both of them still
     * there, for ever.
     *
     * A module that adds nothing now claims nothing. Replacing the tracks is
     * `repair.replace-incompatible-audio`, which says so in the plan; leaving
     * them is the third setting, and leaves the findings unresolved, which is
     * the truth about them.
     */
    if (!state.needsCompatibilityAudio) return {}
    if (audio.length === 0) return {}

    // Derive the companion track from the audio the viewer would actually pick:
    // the one chosen as default, so the new track carries the right language.
    const chosen =
      audio.find((s) => s.index === state.defaultAudioIndex) ??
      audio.find((s) => audioCodecTier(s.codec, s.profile) !== 'universal') ??
      audio[0]
    const channels = Math.max(2, Math.min(chosen.channels || 2, MAX_SAFE_CHANNELS))
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
}
