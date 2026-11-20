/**
 * Containers outside the two Plex handles reliably.
 */

import type { CheckModule } from '../framework.js'

export const containerUnsupported: CheckModule = {
  id: 'check.container-unsupported',
  title: 'Unusual container',
  summary: 'AVI, WMV, FLV and the rest, which Plex handles unevenly',
  whatItDoes:
    'Finds files in containers outside the two Plex is reliable with. The container is the wrapper, not the ' +
    'video — an AVI can hold perfectly ordinary video — but the wrapper itself is enough to make clients ' +
    'behave unpredictably.',
  howItWorks:
    'Anything that is neither MP4 nor Matroska is flagged. Rewrapping is a copy of the existing streams into a ' +
    'new container, so it costs disk time and nothing else.',
  ifDisabled:
    'AVI, WMV, FLV and similar files are left as they are, and no rewrap is proposed for them.',
  raises: ['container-unsupported'],

  run({ file }) {
    if (file.container !== 'other') return {}

    return {
      signals: { containerChange: true },
      findings: [
        {
          code: 'container-unsupported',
          severity: 'blocker',
          remedy: 'lossless',
          title: `Container "${file.formatName}" is outside Plex's reliable set`,
          detail: 'Plex handles MP4 and MKV reliably across clients; other containers are hit and miss.'
        }
      ]
    }
  }
}
