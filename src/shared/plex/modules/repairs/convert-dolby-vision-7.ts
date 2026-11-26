/**
 * Converting Dolby Vision profile 7 to 8.1, without re-encoding the picture.
 */

import type { RepairModule } from '../framework.js'

export const convertDolbyVision7: RepairModule = {
  id: 'repair.convert-dolby-vision-7',
  title: 'Convert Dolby Vision profile 7',
  summary: 'Rewrites a dual-layer Dolby Vision stream as single-layer profile 8.1',
  whatItDoes:
    'Turns a Dolby Vision profile 7 file — what a UHD Blu-ray rip carries — into profile 8.1, which plays on ' +
    'everything. The picture is not re-encoded: profile 7 already holds a correct HDR10 base layer, and all ' +
    'that makes the file awkward is the second enhancement layer beside it and an RPU that announces a ' +
    'profile most hardware will not touch. Discard the one, rewrite the other, and the same bytes of picture ' +
    'become a file that Dolby Vision clients decode and everything else falls back on cleanly.',
  howItWorks:
    'The video stream is pushed through the bundled dovi_tool, which is the only thing that rewrites a Dolby ' +
    'Vision RPU — nothing in ffmpeg can. It comes back as a single-layer stream and is muxed in place of the ' +
    'original track, with every other track copied across untouched. The cost is one pass over the file ' +
    'rather than the hours a re-encode would take.\n\n' +
    'The enhancement layer is discarded, which is the part worth understanding. On a minimum-enhancement-' +
    'layer disc it carries nothing the base layer does not already have, and losing it costs nothing at all. ' +
    'On a full-enhancement-layer disc it carries real picture detail, and that detail is gone — on a display ' +
    'that was showing it, which in practice means a Dolby Vision television fed by a player that could ' +
    'handle dual-layer. Plex could not.',
  ifDisabled:
    'Profile 7 files are reported and left alone, which is what the app did before dovi_tool was bundled.',
  answers: ['video-dolby-vision-profile'],

  run({ video, state }) {
    if (!state.convertDolbyVision7) return {}
    const source = video[0]
    if (!source) return {}

    // A re-encode already rewrites the stream from scratch, and the two cannot
    // both own the video track. The transcode wins: it is only ever chosen
    // when something about the picture itself has to change.
    if (state.needsTranscode) return {}

    return {
      // A stream copy for everything ffmpeg touches: the conversion happens
      // before ffmpeg is handed anything to write.
      strategy: 'remux',
      plan: {
        dolbyVision7To81: {
          sourceStreamIndex: source.index,
          frameRate: source.frameRate
        }
      },
      actions: [
        {
          label: 'Convert Dolby Vision profile 7 to profile 8.1',
          detail:
            'The enhancement layer is discarded and the Dolby Vision metadata rewritten as single-layer 8.1. ' +
            'The picture is copied through, not re-encoded, so this costs one pass over the file. Clients ' +
            'that cannot decode Dolby Vision get the HDR10 base layer, which is what profile 7 would not ' +
            'give them.'
        }
      ]
    }
  }
}
