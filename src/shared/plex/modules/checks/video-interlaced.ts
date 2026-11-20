/**
 * Interlaced video, which Plex deinterlaces on the server.
 */

import type { CheckModule } from '../framework.js'

export const videoInterlaced: CheckModule = {
  id: 'check.video-interlaced',
  title: 'Interlaced video',
  summary: 'Fields rather than frames, which forces server-side deinterlacing',
  whatItDoes:
    'Finds video stored as interlaced fields — the broadcast and DVD heritage format — which has to be woven ' +
    'into frames before it can be shown on anything modern. Few clients do that well, so Plex does it on the ' +
    'server, and doing it on the server means a full transcode on every play.',
  howItWorks:
    'Reads the field order the file reports. Anything other than progressive is interlaced, and any re-encode ' +
    'of it has to deinterlace as it goes — done once during the repair, it never has to happen again.',
  ifDisabled:
    'Interlaced files are reported as fine and keep forcing a server-side deinterlace, which is a transcode, ' +
    'every time anyone plays them.',
  raises: ['video-interlaced'],

  run({ video }) {
    const stream = video[0]
    if (!stream?.isInterlaced) return {}

    return {
      signals: { needsTranscode: true, needsDeinterlace: true },
      findings: [
        {
          code: 'video-interlaced',
          severity: 'warning',
          remedy: 'transcode',
          title: `Interlaced video (${stream.fieldOrder ?? 'interlaced'})`,
          detail:
            'Few clients deinterlace well, so Plex deinterlaces server-side — which means a full transcode. ' +
            'Deinterlacing once during a re-encode avoids that.',
          streamIndexes: [stream.index]
        }
      ]
    }
  }
}
