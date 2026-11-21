/**
 * Moving the MP4 index to the front, so playback can start at once.
 */

import type { RepairModule } from '../framework.js'

export const moveIndexToFront: RepairModule = {
  id: 'repair.move-index-to-front',
  title: 'Move the MP4 index to the front',
  summary: 'Rewrites the file so a client can start playing without fetching all of it',
  whatItDoes:
    'Rewrites an MP4 so its index sits at the front of the file instead of the end. Nothing in the video or ' +
    'audio changes; the pieces are written in a different order. A client can then start playing immediately ' +
    'rather than waiting for the whole file to arrive.',
  howItWorks:
    'The file is rewritten with every stream copied, and the index written first. Any MP4 this app produces ' +
    'is written that way as a matter of course — what this module decides is whether a file whose *only* ' +
    'problem is the index position is worth rewriting at all.',
  ifDisabled:
    'A file whose only problem is where its index sits will be left alone. Remote clients will keep stalling ' +
    'on it. Files rewritten for some other reason still come out index-first.',
  answers: ['mp4-not-faststart'],

  run({ file }) {
    if (file.faststart !== false) return {}
    return { strategy: 'remux', remuxParts: ['move the index to the front of the file'] }
  }
}
