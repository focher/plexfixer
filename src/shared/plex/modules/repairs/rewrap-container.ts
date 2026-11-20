/**
 * Putting the same streams into a different wrapper.
 */

import type { RepairModule } from '../framework.js'

export const rewrapContainer: RepairModule = {
  id: 'repair.rewrap-container',
  title: 'Rewrap the container',
  summary: 'Copies the streams into MP4, or into MKV, without re-encoding',
  whatItDoes:
    'Writes the file into a different container. The video and audio are copied across untouched, bit for ' +
    'bit — only the wrapper around them changes. It is the cheapest repair there is: the cost is reading and ' +
    'writing the file once.',
  howItWorks:
    'Runs when a check has decided the file should end up in a different container from the one it is in — ' +
    'an MKV that can become an MP4, or a file in something unusual that should be in one of the two. The ' +
    'target was settled earlier, and will have stayed MKV if anything inside the file could not have made the ' +
    'journey.',
  ifDisabled:
    'Files stay in the container they arrived in. MKVs that browsers and older TVs have to repackage on every ' +
    'play will stay MKVs, and an AVI will stay an AVI.',
  answers: ['container-not-mp4', 'container-unsupported'],

  run({ state }) {
    if (!state.containerChange) return {}
    return { strategy: 'remux', remuxParts: [`rewrap as ${state.targetContainer.toUpperCase()}`] }
  }
}
