/**
 * Where the repaired file is headed, and what can stop it going there.
 */

import { defineCheck } from '../framework.js'
import { canStreamCopyIntoMp4 } from '../../rules.js'

export const containerTarget = defineCheck({
  id: 'check.container-target',
  title: 'Target container',
  summary: 'Decides whether the repair can produce MP4, or has to stay MKV',
  whatItDoes:
    'Settles where a repaired file is going before anything else plans around it. MP4 is the preferred target ' +
    'because it plays everywhere, but not every file can get there: MP4 simply cannot store some codecs. This ' +
    'module decides, and says so when the answer is no.',
  howItWorks:
    'Starts from the target container under Compatibility, then applies two limits. A Matroska file is only ' +
    'converted when "Remux MKV to MP4" is on. And if a track could not survive the move — lossless audio, ' +
    'usually, or a video codec MP4 cannot hold — the file stays MKV rather than losing it. A video codec only ' +
    'blocks the move when the video is being copied: a re-encode produces H.264 or HEVC, which MP4 takes ' +
    'happily. Audio is treated more carefully than video, because dropping a lossless track to satisfy the ' +
    'container would destroy something you may well want.',
  ifDisabled:
    'The target container is whatever Compatibility says, with no sanity check. A file whose audio MP4 cannot ' +
    'store will have the repair attempted into MP4 anyway.',
  raises: ['container-blocked-by-stream'],

  params: {
    remuxMkvToMp4: {
      type: 'boolean',
      label: 'Rewrap MKV to MP4 when the streams allow it',
      help: 'MKV forces a Direct Stream remux on browsers and some TVs.'
    }
  },

  run({ file, video, audio, settings, state, params }) {
    let targetContainer = settings.targetContainer

    if (file.container === 'matroska' && !(params.remuxMkvToMp4 && settings.targetContainer === 'mp4')) {
      targetContainer = 'mkv'
    }

    // A video codec MP4 cannot hold only forces MKV if we are not re-encoding
    // the video anyway — a re-encode produces H.264/HEVC, which MP4 accepts.
    const videoBlocksMp4 =
      video[0] != null && !canStreamCopyIntoMp4('video', video[0].codec) && !state.needsTranscode

    // Audio is different: dropping a lossless track to satisfy the container
    // would destroy data the user may well care about, so the container yields
    // instead and the file stays MKV.
    const audioBlockingMp4 = audio.filter((s) => !canStreamCopyIntoMp4('audio', s.codec))

    if (targetContainer === 'mp4' && file.container !== 'mp4' && (videoBlocksMp4 || audioBlockingMp4.length > 0)) {
      const reason =
        audioBlockingMp4.length > 0
          ? `${[...new Set(audioBlockingMp4.map((s) => s.codec.toUpperCase()))].join(' and ')} audio`
          : `${video[0]?.codec.toUpperCase()} video`
      return {
        signals: { targetContainer: 'mkv' },
        findings: [
          {
            code: 'container-blocked-by-stream',
            severity: 'info',
            remedy: 'manual',
            title: `Cannot rewrap to MP4: ${reason} is not storable in MP4`,
            detail:
              `MP4 cannot hold ${reason}. The file stays MKV so the track is not lost — dropping it would be ` +
              'destructive. Clients that cannot read MKV will Direct Stream it, which is cheap compared with a ' +
              'full transcode.'
          }
        ]
      }
    }

    return { signals: { targetContainer } }
  }
})
