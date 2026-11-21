/**
 * Where the MP4 index sits, which decides whether playback can start at once.
 */

import type { CheckModule } from '../framework.js'

export const mp4Faststart: CheckModule = {
  id: 'check.mp4-faststart',
  title: 'MP4 index position',
  summary: 'MP4s whose index sits at the end, so remote clients stall',
  whatItDoes:
    'Finds MP4 files whose index — the table saying where everything is — was written at the end rather than ' +
    'the front. A client has to read the index before it can play a single frame, so with the index at the ' +
    'back, a remote client either waits while the whole file is fetched or gives up and asks the server to ' +
    'transcode instead.',
  howItWorks:
    'Checks which comes first in the file, the index or the media data. Moving it is a rewrite of the file’s ' +
    'structure with every stream copied untouched, and once the file is being written as MP4 at all it is ' +
    'written index-first as a matter of course.',
  ifDisabled:
    'MP4s that stall on remote connections will be reported as healthy, and a file whose only problem is the ' +
    'index position will not be rewritten.',
  raises: ['mp4-not-faststart'],

  run({ file }) {
    if (file.container !== 'mp4' || file.faststart !== false) return {}

    return {
      // Whatever the target container setting says, a file being rewritten to
      // move its index stays MP4: the fix only exists there.
      signals: { targetContainer: 'mp4' },
      findings: [
        {
          code: 'mp4-not-faststart',
          severity: 'blocker',
          remedy: 'lossless',
          title: 'MP4 index (moov atom) is at the end of the file',
          detail:
            'A client has to read the index before it can start playing. With the moov atom at the end, remote ' +
            'clients stall while the whole file is fetched, or fall back to transcoding. Moving it to the front is ' +
            'a metadata-only rewrite.'
        }
      ]
    }
  }
}
