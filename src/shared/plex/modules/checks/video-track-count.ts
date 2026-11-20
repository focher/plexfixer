/**
 * How many video tracks there are: none, or more than one.
 */

import type { CheckModule } from '../framework.js'

export const videoTrackCount: CheckModule = {
  id: 'check.video-track-count',
  title: 'Video track count',
  summary: 'A file with no video track, or with more than one',
  whatItDoes:
    'Checks that the file has exactly one video track. A file with none will not play as a film or an episode ' +
    'at all; a file with several confuses both client decoders and Plex’s own metadata matching, and the ' +
    'extra tracks are almost always leftovers from a bad merge.',
  howItWorks:
    'Counts the video tracks, ignoring embedded artwork — a poster muxed into a file looks like a video track ' +
    'to anything reading it, and counting it would flag half a library.',
  ifDisabled:
    'Files with no video, and files carrying a stray second video track, are treated as normal. The extra ' +
    'track will be carried into the repaired file rather than left out.',
  raises: ['video-missing', 'video-multiple'],

  run({ video }) {
    if (video.length === 0) {
      return {
        findings: [
          {
            code: 'video-missing',
            severity: 'blocker',
            remedy: 'manual',
            title: 'No video track',
            detail: 'The file contains no video stream and will not play as a movie or episode.'
          }
        ]
      }
    }

    if (video.length > 1) {
      return {
        findings: [
          {
            code: 'video-multiple',
            severity: 'warning',
            remedy: 'lossless',
            title: `${video.length} video tracks`,
            detail:
              'Extra video tracks confuse client decoders and Plex metadata matching. Keeping only the primary ' +
              'track avoids it.',
            streamIndexes: video.map((s) => s.index)
          }
        ]
      }
    }

    return {}
  }
}
