/**
 * Encrypted files, which nothing here can repair.
 */

import type { CheckModule } from '../framework.js'
import { isDrmProtected } from '../../rules.js'

export const drmProtected: CheckModule = {
  id: 'check.drm-protected',
  title: 'DRM-protected files',
  summary: 'Spots encrypted files before anything tries to repair them',
  whatItDoes:
    'Finds files whose streams are encrypted — the form purchased iTunes and Apple TV downloads arrive in — ' +
    'and says plainly that no repair is possible, rather than letting a repair start and fail halfway through ' +
    'with an error about an unsupported codec.',
  howItWorks:
    'Every video track carries a four-letter tag naming its format. FairPlay encryption replaces that tag with ' +
    'one of its own, so the tag alone is enough: if a video track is tagged as encrypted, the file is.',
  ifDisabled:
    'Encrypted files will look like ordinary ones. A repair will be offered, will run, and will fail — ' +
    'ffmpeg cannot read the streams at all, not even to copy them.',
  raises: ['drm-protected'],

  run({ file }) {
    const drmStreams = file.streams.filter(
      (stream) => stream.kind === 'video' && isDrmProtected(stream.codecTag)
    )
    if (drmStreams.length === 0) return {}

    return {
      findings: [
        {
          code: 'drm-protected',
          severity: 'blocker',
          remedy: 'manual',
          title: 'DRM-protected file',
          detail:
            'The streams are encrypted (FairPlay), which is how purchased iTunes and Apple TV downloads are ' +
            'delivered. ffmpeg cannot decode or even copy them, so no repair is possible. Plex will transcode or ' +
            'refuse the file depending on the client; replacing it with a DRM-free copy is the only fix.',
          streamIndexes: drmStreams.map((stream) => stream.index)
        }
      ]
    }
  }
}
