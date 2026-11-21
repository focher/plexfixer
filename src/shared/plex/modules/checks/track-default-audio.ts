/**
 * Which audio track plays when nobody chooses one.
 */

import type { CheckModule } from '../framework.js'
import { UNDEFINED_LANGUAGE, languageName, normalizeLanguage } from '../../../languages.js'
import { audioQuality, isCommentaryTrack } from '../../tracks.js'
import { effectiveLanguage } from './track-language.js'
import type { AudioStream, Finding, TrackPlanChange } from '../../../types.js'

export const trackDefaultAudio: CheckModule = {
  id: 'check.track-default-audio',
  title: 'Default audio track',
  summary: 'Which track plays by default, and whether it is the right one',
  whatItDoes:
    'Decides which audio track should play when the viewer has expressed no preference, and reports where the ' +
    'file disagrees. This is the single most common reason a film starts in the wrong language, or starts on ' +
    'the director’s commentary. A file can be flawlessly compatible and still do this.',
  howItWorks:
    'Works out the film’s own language, then looks for the best audio track in it — falling back through ' +
    'the languages listed under Languages, and then to anything at all. Commentary and descriptive-audio ' +
    'tracks are passed over when "Never default to commentary" is on. Among the candidates, a track already ' +
    'flagged as the default keeps the flag rather than being churned for no reason; otherwise the most ' +
    'compatible track wins, with more channels as the tie-break. Three separate complaints come out of this: ' +
    'no track is flagged, several are, or the flagged one is in the wrong language.',
  ifDisabled:
    'The file’s own default flags are left exactly as they are, including a file with none and a file ' +
    'with three.',
  raises: [
    'preferred-audio-language-absent',
    'default-audio-missing',
    'default-audio-multiple',
    'default-audio-language-mismatch'
  ],

  run({ audio, settings, primary, state }) {
    if (audio.length === 0) return {}

    const findings: Finding[] = []
    const changes: TrackPlanChange[] = []
    const primaryLanguage = primary.language
    const languageOf = (stream: AudioStream): string => effectiveLanguage(stream, state.trackChanges)

    const eligible = audio.filter((s) => {
      if (settings.avoidCommentaryAsDefault && isCommentaryTrack(s)) return false
      if (s.disposition.visualImpaired) return false
      return true
    })
    const pool = eligible.length > 0 ? eligible : audio

    // Try the primary language, then each configured fallback, then anything.
    const searchOrder = [primaryLanguage, ...settings.fallbackAudioLanguages.map(normalizeLanguage)]
    let candidates: AudioStream[] = []
    let matchedLanguage: string | undefined
    for (const language of searchOrder) {
      if (language === UNDEFINED_LANGUAGE) continue
      const found = pool.filter((s) => normalizeLanguage(languageOf(s)) === language)
      if (found.length > 0) {
        candidates = found
        matchedLanguage = language
        break
      }
    }
    if (candidates.length === 0) {
      candidates = [...pool]
      matchedLanguage = normalizeLanguage(languageOf(pool[0]))
    }

    // Keep an existing, qualifying default rather than churning the file.
    const alreadyDefault = candidates.find((s) => s.disposition.default)
    const chosen =
      alreadyDefault ?? [...candidates].sort((a, b) => audioQuality(b) - audioQuality(a) || a.index - b.index)[0]

    const defaultAudioIndex = chosen.index
    const defaultAudioLanguage = normalizeLanguage(languageOf(chosen))

    if (matchedLanguage && matchedLanguage !== primaryLanguage && primaryLanguage !== UNDEFINED_LANGUAGE) {
      findings.push({
        code: 'preferred-audio-language-absent',
        severity: 'warning',
        remedy: 'manual',
        title: `No ${languageName(primaryLanguage)} audio track`,
        detail:
          `The file's primary language is ${languageName(primaryLanguage)} but no audio track carries that ` +
          `language, so ${languageName(matchedLanguage)} was chosen as the default instead.`,
        streamIndexes: [chosen.index]
      })
    }

    const currentDefaults = audio.filter((s) => s.disposition.default)
    if (currentDefaults.length === 0) {
      findings.push({
        code: 'default-audio-missing',
        severity: 'warning',
        remedy: 'lossless',
        title: 'No default audio track',
        detail:
          'With no track flagged as default, clients fall back to the first audio stream — which is often a ' +
          'commentary or foreign dub. Flagging the intended track removes the guesswork.',
        streamIndexes: audio.map((s) => s.index)
      })
    } else if (currentDefaults.length > 1) {
      findings.push({
        code: 'default-audio-multiple',
        severity: 'warning',
        remedy: 'lossless',
        title: `${currentDefaults.length} audio tracks flagged as default`,
        detail:
          'Multiple default audio tracks is undefined behaviour; different clients resolve it differently, so ' +
          'the same file plays a different language on different devices.',
        streamIndexes: currentDefaults.map((s) => s.index)
      })
    } else if (currentDefaults[0].index !== defaultAudioIndex) {
      const current = currentDefaults[0]
      findings.push({
        code: 'default-audio-language-mismatch',
        severity: 'warning',
        remedy: 'lossless',
        title: `Default audio is ${languageName(languageOf(current))}, not ${languageName(defaultAudioLanguage)}`,
        detail:
          `The default audio track (#${current.index}${current.title ? `, "${current.title}"` : ''}) does not ` +
          `match the video's language (${languageName(primaryLanguage)}). Clients without an explicit language ` +
          'preference will play the wrong track.',
        streamIndexes: [current.index, defaultAudioIndex]
      })
    }

    for (const stream of audio) {
      const shouldBeDefault = stream.index === defaultAudioIndex
      if (stream.disposition.default !== shouldBeDefault) {
        changes.push({
          streamIndex: stream.index,
          kind: 'audio',
          setDefault: shouldBeDefault,
          reason: shouldBeDefault
            ? `Default ${languageName(defaultAudioLanguage)} audio track`
            : 'Clearing stray default flag'
        })
      }
    }

    return {
      findings,
      signals: { trackChanges: changes, defaultAudioIndex, defaultAudioLanguage }
    }
  }
}
