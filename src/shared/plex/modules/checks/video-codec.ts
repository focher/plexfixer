/**
 * Whether the video codec itself direct plays.
 */

import { defineCheck } from '../framework.js'
import { videoCodecTier } from '../../rules.js'

export const videoCodec = defineCheck({
  id: 'check.video-codec',
  title: 'Video codec support',
  summary: 'Codecs clients cannot decode, or can only decode on recent hardware',
  whatItDoes:
    'Looks at what the video is encoded with and asks whether a Plex client can play it as-is. A codec no ' +
    'client can decode means the server re-encodes the video on every single play, which is the most expensive ' +
    'thing a Plex server ever does. A codec only recent devices handle means some of your clients will, and ' +
    'some will not.',
  howItWorks:
    'Each codec sits in one of three groups: decoded everywhere (H.264), decoded by recent hardware (HEVC, ' +
    'VP9, AV1), or decoded by essentially nothing (MPEG-2, VC-1, DivX and the rest). HEVC is treated as fine ' +
    'when "Treat HEVC as compatible" is on under Compatibility, which it is by default.',
  ifDisabled:
    'Nothing is said about the codec, so a library full of MPEG-2 or VC-1 will look healthy while the server ' +
    'transcodes every play.',
  raises: ['video-codec-unsupported', 'video-codec-limited'],

  params: {
    allowHevc: {
      type: 'boolean',
      label: 'Treat HEVC as compatible',
      help: 'Turn this off if any client is a browser or a streaming box older than about 2017.'
    }
  },

  run({ video, params }) {
    const stream = video[0]
    if (!stream) return {}

    const codec = stream.codec.toLowerCase()
    const tier = videoCodecTier(codec)

    if (tier === 'none') {
      return {
        signals: { needsTranscode: true },
        findings: [
          {
            code: 'video-codec-unsupported',
            severity: 'blocker',
            remedy: 'transcode',
            title: `Video codec ${stream.codec.toUpperCase()} is not direct-playable`,
            detail:
              `No mainstream Plex client can decode ${stream.codec.toUpperCase()}, so the server re-encodes the video ` +
              'on every play. Re-encoding once to H.264 removes that cost permanently.',
            streamIndexes: [stream.index]
          }
        ]
      }
    }

    if (tier === 'limited' && !(codec === 'hevc' && params.allowHevc)) {
      const isHevc = codec === 'hevc' || codec === 'h265'
      return {
        signals: { needsTranscode: true },
        findings: [
          {
            code: 'video-codec-limited',
            severity: 'warning',
            remedy: 'transcode',
            title: `Video codec ${stream.codec.toUpperCase()} only direct plays on recent devices`,
            detail: isHevc
              ? 'HEVC direct plays on recent TVs, Apple devices and phones, but not in most browsers or on older ' +
                'streaming boxes. Enable "Treat HEVC as compatible" in Settings if your clients all support it.'
              : `${stream.codec.toUpperCase()} has patchy hardware decoder coverage; a meaningful share of clients ` +
                'will transcode it.',
            streamIndexes: [stream.index]
          }
        ]
      }
    }

    return {}
  }
})
