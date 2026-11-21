/**
 * Whether subtitles come up on their own, and which ones.
 */

import type { CheckModule } from '../framework.js'
import { languageName, normalizeLanguage } from '../../../languages.js'
import { isImageSubtitle } from '../../rules.js'
import { looksForced, looksSdh } from '../../tracks.js'
import { effectiveLanguage } from './track-language.js'
import type { Finding, SubtitleStream, TrackPlanChange } from '../../../types.js'

export const trackDefaultSubtitle: CheckModule = {
  id: 'check.track-default-subtitle',
  title: 'Default subtitle track',
  summary: 'Whether subtitles appear unasked, and whether the right ones do',
  whatItDoes:
    'Decides whether a subtitle track should come up on its own, and which. The two failures are opposite and ' +
    'both annoying: subtitles appearing over dialogue the viewer already understands, and no subtitles for a ' +
    'film in a language they do not. A third is worse than either — an image subtitle track flagged as ' +
    'default, which makes Plex re-encode the video for every client that plays the file.',
  howItWorks:
    'Compares the language of the default audio with the preferred subtitle language. When they match, the ' +
    'viewer understands the dialogue, so only a forced or signs-only track belongs on screen — and only if ' +
    '"Prefer forced subtitles" is on. When they differ, the film is in a foreign language, so a full subtitle ' +
    'track is brought up if "Default subtitles for foreign audio" is on, preferring an ordinary track over a ' +
    'hearing-impaired one. Image subtitles are never chosen, whatever else is true.',
  ifDisabled:
    'Subtitle default flags are left as the file has them, including an image track flagged as default, which ' +
    'costs a full transcode every time the file is played.',
  raises: [
    'default-subtitle-multiple',
    'subtitle-image-default',
    'default-subtitle-unwanted',
    'default-subtitle-language-mismatch'
  ],

  run({ subtitles, settings, state }) {
    if (subtitles.length === 0) return {}

    const findings: Finding[] = []
    const changes: TrackPlanChange[] = []
    const languageOf = (stream: SubtitleStream): string => effectiveLanguage(stream, state.trackChanges)

    const preferredSubLanguage = normalizeLanguage(settings.preferredSubtitleLanguage)
    const defaultAudioLanguage = state.defaultAudioLanguage
    const audioMatchesSubPreference = defaultAudioLanguage === preferredSubLanguage

    // Image subtitles must never be default: Plex burns them in, which turns a
    // direct play into a full video transcode.
    const usable = subtitles.filter((s) => !isImageSubtitle(s.codec))
    const inPreferred = usable.filter((s) => normalizeLanguage(languageOf(s)) === preferredSubLanguage)

    let defaultSubtitleIndex: number | undefined

    if (audioMatchesSubPreference) {
      // Audio is already in the viewer's language — only forced/signs subtitles
      // belong on screen, and only if the user asked for them.
      if (settings.preferForcedSubtitles) {
        const forced = inPreferred.filter((s) => looksForced(s))
        if (forced.length > 0) defaultSubtitleIndex = forced[0].index
      }
    } else if (settings.defaultSubtitleWhenForeignAudio) {
      // Audio is in another language — a full subtitle track should come up.
      const full = inPreferred.filter((s) => !looksForced(s) && !looksSdh(s))
      const fallback = inPreferred.filter((s) => !looksForced(s))
      const pick = full[0] ?? fallback[0] ?? inPreferred[0]
      if (pick) defaultSubtitleIndex = pick.index
    }

    const currentDefaults = subtitles.filter((s) => s.disposition.default)

    if (currentDefaults.length > 1) {
      findings.push({
        code: 'default-subtitle-multiple',
        severity: 'warning',
        remedy: 'lossless',
        title: `${currentDefaults.length} subtitle tracks flagged as default`,
        detail: 'Clients disagree on which one wins, so subtitles behave differently on different devices.',
        streamIndexes: currentDefaults.map((s) => s.index)
      })
    }

    for (const stream of currentDefaults) {
      if (stream.index === defaultSubtitleIndex) continue
      const streamLanguage = normalizeLanguage(languageOf(stream))
      if (isImageSubtitle(stream.codec)) {
        findings.push({
          code: 'subtitle-image-default',
          severity: 'blocker',
          remedy: 'lossless',
          title: `Image subtitle track #${stream.index} is flagged as default`,
          detail:
            'PGS/VobSub subtitles cannot be rendered as text, so Plex burns them into the picture — forcing a ' +
            'full video transcode on every client, even ones that could have direct played the file. Clearing ' +
            'the default flag restores direct play.',
          streamIndexes: [stream.index]
        })
      } else if (audioMatchesSubPreference && !looksForced(stream)) {
        findings.push({
          code: 'default-subtitle-unwanted',
          severity: 'info',
          remedy: 'lossless',
          title: `Subtitles default on with ${languageName(defaultAudioLanguage)} audio`,
          detail:
            `Subtitle track #${stream.index} comes up automatically even though the audio is already in ` +
            `${languageName(defaultAudioLanguage)}. Usually unwanted.`,
          streamIndexes: [stream.index]
        })
      } else if (streamLanguage !== preferredSubLanguage) {
        findings.push({
          code: 'default-subtitle-language-mismatch',
          severity: 'info',
          remedy: 'lossless',
          title: `Default subtitle is ${languageName(streamLanguage)}, not ${languageName(preferredSubLanguage)}`,
          detail: 'The automatically displayed subtitle track is not in the preferred subtitle language.',
          streamIndexes: [stream.index]
        })
      }
    }

    for (const stream of subtitles) {
      const shouldBeDefault = stream.index === defaultSubtitleIndex
      if (stream.disposition.default !== shouldBeDefault) {
        changes.push({
          streamIndex: stream.index,
          kind: 'subtitle',
          setDefault: shouldBeDefault,
          reason: shouldBeDefault
            ? `Default ${languageName(preferredSubLanguage)} subtitle track`
            : isImageSubtitle(stream.codec)
              ? 'Clearing default on image subtitles to avoid forced burn-in'
              : 'Clearing stray default flag'
        })
      }
    }

    return { findings, signals: { trackChanges: changes, defaultSubtitleIndex } }
  }
}
