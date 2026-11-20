/**
 * Tracks with no language tag at all.
 */

import type { CheckModule } from '../framework.js'
import { UNDEFINED_LANGUAGE, isUndefinedLanguage, languageName, normalizeLanguage } from '../../../languages.js'
import type { TrackPlanChange } from '../../../types.js'

export const trackLanguageMissing: CheckModule = {
  id: 'check.track-language-missing',
  title: 'Missing language tags',
  summary: 'Tracks with no language at all, which Plex can only guess at',
  whatItDoes:
    'Finds audio, subtitle and video tracks carrying no language tag. Plex matches tracks against what a ' +
    'client asks for by language; with nothing to match on it falls back to the order the tracks happen to be ' +
    'in, which is why a file sometimes comes up in the wrong language on one device and the right one on ' +
    'another.',
  howItWorks:
    'Looks for tracks tagged as undefined or not tagged at all. Audio and subtitle tracks are given the ' +
    'language set as "Assume untagged tracks are" under Languages; a video track is given the film’s own ' +
    'language, so the file states what it is.',
  ifDisabled:
    'Untagged tracks stay untagged, and track selection stays dependent on the order tracks happen to sit in.',
  raises: ['language-missing'],

  run({ video, audio, subtitles, settings, primary }) {
    const assumed = normalizeLanguage(settings.assumeUndefinedIs)
    const untagged = [...video, ...audio, ...subtitles].filter((s) => isUndefinedLanguage(s.language))
    if (untagged.length === 0) return {}

    const changes: TrackPlanChange[] = []
    for (const stream of untagged) {
      // Audio and subtitle tracks get the assumed language; a video stream gets
      // the primary language so it states the title's language explicitly.
      const target = stream.kind === 'video' ? primary.language : assumed
      if (target === UNDEFINED_LANGUAGE) continue
      changes.push({
        streamIndex: stream.index,
        kind: stream.kind,
        setLanguage: target,
        reason: `Untagged ${stream.kind} track; tagging as ${languageName(target)}`
      })
    }

    return {
      signals: { trackChanges: changes },
      findings: [
        {
          code: 'language-missing',
          severity: 'warning',
          remedy: 'lossless',
          title: `${untagged.length} track${untagged.length === 1 ? '' : 's'} with no language tag`,
          detail:
            'Plex cannot match untagged tracks against a client\'s language preferences, so it falls back to ' +
            `track order. Tagging them as ${languageName(assumed)} makes selection predictable.`,
          streamIndexes: untagged.map((s) => s.index)
        }
      ]
    }
  }
}
