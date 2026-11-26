/**
 * Writing the corrected language tags and default/forced flags.
 */

import type { RepairModule } from '../framework.js'
import { languageName } from '../../../languages.js'

export const fixTrackMetadata: RepairModule = {
  id: 'repair.fix-track-metadata',
  title: 'Fix track languages and flags',
  summary: 'Writes the language tags and default/forced flags the checks worked out',
  whatItDoes:
    'Carries out what the track checks decided: the language tags that were missing or written in a form no ' +
    'player matches, and the default and forced flags that decide what plays when nobody chooses. The streams ' +
    'themselves are copied untouched — this is a metadata rewrite, as fast as copying the file.',
  howItWorks:
    'Collects every change the language, default-audio, default-subtitle and forced-subtitle checks produced ' +
    'and writes them in one pass. Each change carries its own reason, listed in the plan before anything is ' +
    'written, so there is no mystery about why a flag moved.',
  ifDisabled:
    'The checks still report what is wrong with the track metadata, but nothing is corrected — the file comes ' +
    'back with the same tags and flags it went in with.',
  answers: [
    'language-missing',
    'language-nonstandard',
    'default-audio-missing',
    'default-audio-multiple',
    'default-audio-language-mismatch',
    'default-subtitle-multiple',
    'default-subtitle-unwanted',
    'default-subtitle-language-mismatch',
    'subtitle-image-default',
    'forced-subtitle-not-flagged'
  ],

  run({ primary, state, trackChanges }) {
    // The live list, not `state.trackChanges`. The subtitle-default repair
    // withdraws itself on MP4, and counting the check's original list meant a
    // file with nothing left to do still listed "Fix 1 default/forced flag" in
    // its plan and was then skipped as already Plex-ready.
    const changes = trackChanges
    if (changes.length === 0) return {}

    const languageFixes = changes.filter((c) => c.setLanguage).length
    const flagFixes = changes.filter((c) => c.setDefault != null || c.setForced != null).length
    const parts: string[] = []
    if (languageFixes > 0) parts.push(`${languageFixes} language tag${languageFixes === 1 ? '' : 's'}`)
    if (flagFixes > 0) parts.push(`${flagFixes} default/forced flag${flagFixes === 1 ? '' : 's'}`)
    // Changes that only drop a track are another module's line to write, and
    // "Fix " on its own is not a sentence.
    if (parts.length === 0) return {}

    return {
      actions: [
        {
          label: `Fix ${parts.join(' and ')}`,
          detail:
            state.defaultAudioLanguage != null
              ? `Default audio becomes the ${languageName(state.defaultAudioLanguage)} track, matching the ` +
                `video's language (${languageName(primary.language)}).`
              : 'Track metadata is corrected so clients select predictably.'
        }
      ]
    }
  }
}
