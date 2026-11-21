/**
 * Forced subtitle tracks that never got the flag saying so.
 */

import type { CheckModule } from '../framework.js'
import { looksForced } from '../../tracks.js'
import type { TrackPlanChange } from '../../../types.js'

export const trackForcedSubtitle: CheckModule = {
  id: 'check.track-forced-subtitle',
  title: 'Forced subtitle flag',
  summary: 'Signs-and-songs tracks that are not flagged as forced',
  whatItDoes:
    'Finds subtitle tracks that are evidently forced — the short ones that translate signs, or the alien ' +
    'dialogue in an otherwise English film — but which never had the forced flag set. Plex uses that flag for ' +
    '"forced subtitles only", so without it the track is treated as a full subtitle track and never comes up ' +
    'when it should.',
  howItWorks:
    'Reads the track title. Titles saying forced, signs, songs, foreign parts or narrative are the convention, ' +
    'and a track whose title says one of those while its flag says otherwise is taken at its word.',
  ifDisabled:
    'Forced tracks stay unflagged, so foreign dialogue in a film goes untranslated unless the viewer picks the ' +
    'track by hand.',
  raises: ['forced-subtitle-not-flagged'],

  run({ subtitles }) {
    // Tracks that are evidently forced but lack the flag: Plex uses the flag to
    // offer "forced subtitles only", so set it.
    const forcedButUnflagged = subtitles.filter((s) => !s.disposition.forced && looksForced(s))
    if (forcedButUnflagged.length === 0) return {}

    const changes: TrackPlanChange[] = forcedButUnflagged.map((stream) => ({
      streamIndex: stream.index,
      kind: 'subtitle' as const,
      setForced: true,
      reason: `Title "${stream.title ?? ''}" indicates a forced track`
    }))

    return {
      signals: { trackChanges: changes },
      findings: [
        {
          code: 'forced-subtitle-not-flagged',
          severity: 'info',
          remedy: 'lossless',
          title: `${forcedButUnflagged.length} forced subtitle track${forcedButUnflagged.length === 1 ? '' : 's'} missing the forced flag`,
          detail:
            'The track title says it is forced/signs-only but the forced disposition is not set, so Plex treats ' +
            'it as a full subtitle track and will not auto-select it for foreign dialogue.',
          streamIndexes: forcedButUnflagged.map((s) => s.index)
        }
      ]
    }
  }
}
