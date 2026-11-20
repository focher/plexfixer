/**
 * MKV, which a good share of clients cannot read directly.
 */

import type { CheckModule } from '../framework.js'

export const containerMkv: CheckModule = {
  id: 'check.container-mkv',
  title: 'MKV container',
  summary: 'Matroska files, which some clients remux on every play',
  whatItDoes:
    'Flags Matroska files when the repair is able to produce MP4. MKV is a fine container and the video inside ' +
    'it is usually untouched by the problem — but browsers, Chromecast, several smart TVs and older Apple TVs ' +
    'cannot read it, so Plex repackages the file for them every single time it is played.',
  howItWorks:
    'Raised only when the target container has come out as MP4, which means "Remux MKV to MP4" is on and ' +
    'nothing inside the file blocks the move. Repackaging copies the streams; the video and audio are not ' +
    're-encoded.',
  ifDisabled:
    'MKV files are left as MKV, and the clients that cannot read them keep paying for a repackage on every ' +
    'play.',
  raises: ['container-not-mp4'],

  run({ file, state }) {
    if (file.container !== 'matroska' || state.targetContainer !== 'mp4') return {}

    return {
      signals: { containerChange: true },
      findings: [
        {
          code: 'container-not-mp4',
          severity: 'warning',
          remedy: 'lossless',
          title: 'MKV container',
          detail:
            'Plex clients that cannot read MKV (browsers, Chromecast, several smart TVs, older Apple TVs) force a ' +
            'Direct Stream remux on every play — extra server work and a common cause of playback stalls on remote ' +
            'connections. MP4 direct plays everywhere.'
        }
      ]
    }
  }
}
