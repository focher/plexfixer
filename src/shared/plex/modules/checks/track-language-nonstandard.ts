/**
 * Language tags written in a form players do not match on.
 */

import type { CheckModule } from '../framework.js'
import { isCanonicalFor, isUndefinedLanguage, languageName } from '../../../languages.js'
import type { TrackPlanChange } from '../../../types.js'

export const trackLanguageNonstandard: CheckModule = {
  id: 'check.track-language-nonstandard',
  title: 'Non-standard language tags',
  summary: 'Tags like "en-US" or "English", or the wrong code for the container',
  whatItDoes:
    'Finds tracks whose language is written in a form players will not recognise. "en-US", "English" and ' +
    '"Eng " all look right to a person and match nothing at all in a client’s language preferences.',
  howItWorks:
    'Compares each tag against the code the output container expects. The subtlety is that MP4 and Matroska ' +
    'disagree about some languages — MP4 wants "fra" for French where Matroska wants "fre" — so a tag that is ' +
    'correct in one is wrong in the other. A tag already in the right form for its container is left alone: ' +
    'rewriting those is what made French tracks show up as unknown in Apple players.',
  ifDisabled:
    'Tags stay as they are, including the ones no client will match against.',
  raises: ['language-nonstandard'],

  run({ file, video, audio, subtitles, state }) {
    // Tags that are not the code this container expects ("en-US", "English",
    // or the wrong ISO 639-2 form — "fre" in an MP4, "fra" in an MKV) are
    // rewritten. A tag already in the right form is left alone.
    const misTagged = [...video, ...audio, ...subtitles].filter(
      (s) => s.rawLanguage && !isUndefinedLanguage(s.rawLanguage) && !isCanonicalFor(s.rawLanguage, file.container)
    )
    if (misTagged.length === 0) return {}

    const changes: TrackPlanChange[] = []
    for (const stream of misTagged) {
      // A track the previous module has already given a language to is left to
      // it: two modules writing the same tag would write it twice.
      if (state.trackChanges.some((c) => c.streamIndex === stream.index && c.setLanguage)) continue
      changes.push({
        streamIndex: stream.index,
        kind: stream.kind,
        // Kept in the canonical /B form like every other language in the plan;
        // the writer converts it to the output container's form.
        setLanguage: stream.language,
        reason: `Retagging "${stream.rawLanguage}" as ${languageName(stream.language)}, in the code the output container expects`
      })
    }

    return {
      signals: { trackChanges: changes },
      findings: [
        {
          code: 'language-nonstandard',
          severity: 'info',
          remedy: 'lossless',
          title: `${misTagged.length} track${misTagged.length === 1 ? '' : 's'} using a non-standard language tag`,
          detail:
            'Tags such as "en-US" or "English", or the wrong form of a three-letter code for this container ' +
            '("fre" where MP4 expects "fra"), are not what players match on. Rewriting them to the code the ' +
            'container expects makes track selection work consistently.',
          streamIndexes: misTagged.map((s) => s.index)
        }
      ]
    }
  }
}
