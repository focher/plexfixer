/**
 * Resolution above the ceiling remote clients can be fed directly.
 */

import type { CheckModule } from '../framework.js'

export const videoResolution: CheckModule = {
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

  run({ video, settings }) {
    const stream = video[0]
    if (!stream || stream.height <= settings.maxHeight) return {}

    return {
      signals: { scaleHeight: settings.maxHeight },
      findings: [
        {
          code: 'video-resolution-high',
          severity: 'warning',
          remedy: 'transcode',
          title: `${stream.width}×${stream.height} exceeds the ${settings.maxHeight}p ceiling`,
          detail:
            'Above the configured ceiling, remote clients on limited bandwidth will downscale server-side. That is ' +
            'a full transcode on every play.',
          streamIndexes: [stream.index]
        }
      ]
    }
  }
}
