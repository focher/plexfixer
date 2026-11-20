/**
 * Chroma subsampling: how much colour detail the picture carries.
 */

import type { CheckModule } from '../framework.js'

export const videoChroma: CheckModule = {
  id: 'check.video-chroma',
  title: 'Chroma subsampling',
  summary: 'Production formats (4:2:2, 4:4:4) that no consumer decoder handles',
  whatItDoes:
    'Finds video that keeps more colour detail than consumer playback hardware knows what to do with. It is ' +
    'not a quality problem — it is the opposite — but a decoder chip built for 4:2:0 cannot take the stream at ' +
    'all, so the server transcodes every play.',
  howItWorks:
    'Reads the chroma subsampling the file reports. Consumer decoders implement 4:2:0 and nothing else; ' +
    '4:2:2 and 4:4:4 are editing and mastering formats that have found their way into a library.',
  ifDisabled:
    'An intermediate or mastering file sitting in the library will be reported as healthy while every client ' +
    'that plays it forces a full transcode.',
  raises: ['video-chroma-unsupported'],

  run({ video }) {
    const stream = video[0]
    if (!stream) return {}
    if (stream.chromaSubsampling !== '4:2:2' && stream.chromaSubsampling !== '4:4:4') return {}

    return {
      signals: { needsTranscode: true, needsPixelFormatChange: true },
      findings: [
        {
          code: 'video-chroma-unsupported',
          severity: 'blocker',
          remedy: 'transcode',
          title: `${stream.chromaSubsampling} chroma subsampling`,
          detail:
            'Consumer decoders only handle 4:2:0. Anything else is a production/intermediate format and is always ' +
            'transcoded for playback.',
          streamIndexes: [stream.index]
        }
      ]
    }
  }
}
