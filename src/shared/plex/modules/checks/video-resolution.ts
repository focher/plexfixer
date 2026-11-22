/**
 * Resolution above the ceiling remote clients can be fed directly.
 */

import { defineCheck } from '../framework.js'

export const videoResolution = defineCheck({
  id: 'check.video-resolution',
  title: 'Resolution ceiling',
  summary: 'Video taller than the height set under Compatibility',
  whatItDoes:
    'Flags video above the resolution ceiling you have set. This is about bandwidth rather than decoding: a ' +
    'remote client on a limited connection cannot take a 4K stream, so the server scales it down — and scaling ' +
    'down is a full transcode, every time.',
  howItWorks:
    'Compares the picture height against the ceiling under Compatibility, which ships at 2160 (4K) — meaning ' +
    'nothing is flagged until you lower it. Lower it to 1080 and the 4K files in the library start showing up.',
  ifDisabled:
    'Nothing is said about resolution, however far above the ceiling a file is.',
  raises: ['video-resolution-high'],

  params: {
    maxHeight: {
      type: 'number',
      label: 'Maximum height',
      help: 'Flag anything taller as likely to be downscaled server-side.',
      options: [
        { value: 720, label: '720p' },
        { value: 1080, label: '1080p' },
        { value: 2160, label: '2160p (4K)' },
        { value: 4320, label: '4320p (8K)' }
      ]
    }
  },

  run({ video, params }) {
    const stream = video[0]
    if (!stream || stream.height <= params.maxHeight) return {}

    return {
      signals: { scaleHeight: params.maxHeight },
      findings: [
        {
          code: 'video-resolution-high',
          severity: 'warning',
          remedy: 'transcode',
          title: `${stream.width}×${stream.height} exceeds the ${params.maxHeight}p ceiling`,
          detail:
            'Above the configured ceiling, remote clients on limited bandwidth will downscale server-side. That is ' +
            'a full transcode on every play.',
          streamIndexes: [stream.index]
        }
      ]
    }
  }
})
