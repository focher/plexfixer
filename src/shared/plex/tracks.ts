/**
 * Default / forced track resolution.
 *
 * A file can be perfectly compatible and still be a bad experience: the wrong
 * audio track plays, subtitles appear when they should not, or three tracks all
 * claim to be the default. This module decides which single audio track and
 * which (at most one) subtitle track should carry the default flag, based on
 * the file's primary language and the user's settings.
 */

import type {
  AudioStream,
  MediaFile,
  MediaStream,
  SubtitleStream,
  VideoStream,
  AppSettings,
  TrackPlanChange,
  Finding
} from '../types.js'
import { UNDEFINED_LANGUAGE, isUndefinedLanguage, languageName, normalizeLanguage } from '../languages.js'
import { audioCodecTier, isImageSubtitle } from './rules.js'

export type PrimaryLanguageSource =
  | 'video-stream-tag'
  | 'preferred-setting'
  | 'majority-audio'
  | 'first-audio'
  | 'fallback'

export interface PrimaryLanguage {
  language: string
  source: PrimaryLanguageSource
}

/** Title keywords that mark a track as a commentary / alternate production track. */
const COMMENTARY_PATTERNS = [/comment/i, /director/i, /behind the scenes/i, /interview/i, /\bisolated score\b/i]

/** Title keywords that mark a subtitle track as forced / signs-only. */
const FORCED_TITLE_PATTERNS = [/forced/i, /\bsigns\b/i, /signs ?(&|and|\/) ?songs/i, /\bforeign parts?\b/i, /\bnarrative\b/i]

/** Title keywords that mark a subtitle track as SDH / hearing-impaired. */
const SDH_TITLE_PATTERNS = [/\bsdh\b/i, /hearing impaired/i, /\bcc\b/i, /closed caption/i]

/**
 * Still-image codecs that only ever show up as embedded artwork, never as a
 * real video track. A poster muxed into an MKV or M4V is a `video` stream as
 * far as ffprobe is concerned, so every consumer has to filter it out the same
 * way — hence one definition here rather than a copy per call site.
 */
const COVER_ART_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'webp'])

/** True when a stream is embedded artwork rather than a playable video track. */
export function isCoverArt(stream: MediaStream): boolean {
  if (stream.kind !== 'video') return false
  if (stream.disposition.attachedPic) return true
  return COVER_ART_CODECS.has(stream.codec.toLowerCase())
}

export function coverArtStreams(file: MediaFile): VideoStream[] {
  return file.streams.filter((s): s is VideoStream => s.kind === 'video' && isCoverArt(s))
}

export function videoStreams(file: MediaFile): VideoStream[] {
  // Cover art in MKV/MP4 shows up as a video stream; exclude those.
  return file.streams.filter((s): s is VideoStream => s.kind === 'video' && !isCoverArt(s))
}

export function audioStreams(file: MediaFile): AudioStream[] {
  return file.streams.filter((s): s is AudioStream => s.kind === 'audio')
}

export function subtitleStreams(file: MediaFile): SubtitleStream[] {
  return file.streams.filter((s): s is SubtitleStream => s.kind === 'subtitle')
}

export function isCommentaryTrack(stream: AudioStream | SubtitleStream): boolean {
  if (stream.disposition.commentary) return true
  const title = stream.title ?? ''
  return COMMENTARY_PATTERNS.some((pattern) => pattern.test(title))
}

export function looksForced(stream: SubtitleStream): boolean {
  if (stream.disposition.forced) return true
  const title = stream.title ?? ''
  return FORCED_TITLE_PATTERNS.some((pattern) => pattern.test(title))
}

export function looksSdh(stream: SubtitleStream): boolean {
  if (stream.disposition.hearingImpaired) return true
  const title = stream.title ?? ''
  return SDH_TITLE_PATTERNS.some((pattern) => pattern.test(title))
}

/**
 * Work out the file's primary language — the language the content is "in".
 *
 * The video stream's own language tag wins when it is set, since that is the
 * explicit statement of intent for the title. Otherwise fall back to the audio
 * tracks, preferring the language the user asked for when it is present.
 */
export function resolvePrimaryLanguage(file: MediaFile, settings: AppSettings): PrimaryLanguage {
  const video = videoStreams(file)[0]
  if (video && !isUndefinedLanguage(video.language)) {
    return { language: normalizeLanguage(video.language), source: 'video-stream-tag' }
  }

  const audio = audioStreams(file).filter((s) => !isCommentaryTrack(s))
  const tagged = audio.filter((s) => !isUndefinedLanguage(s.language))

  const preferred = normalizeLanguage(settings.preferredAudioLanguage)
  if (tagged.some((s) => normalizeLanguage(s.language) === preferred)) {
    return { language: preferred, source: 'preferred-setting' }
  }

  if (tagged.length > 0) {
    const counts = new Map<string, number>()
    for (const stream of tagged) {
      const key = normalizeLanguage(stream.language)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const [topLanguage, topCount] = ranked[0]
    // A clear majority is a real signal; a tie is not, so fall through to the
    // first track's language in that case.
    if (ranked.length === 1 || topCount > (ranked[1]?.[1] ?? 0)) {
      return { language: topLanguage, source: 'majority-audio' }
    }
    return { language: normalizeLanguage(tagged[0].language), source: 'first-audio' }
  }

  if (audio.length > 0) {
    return { language: normalizeLanguage(settings.assumeUndefinedIs), source: 'fallback' }
  }

  return { language: UNDEFINED_LANGUAGE, source: 'fallback' }
}

/** Rank audio tracks so the "best" one in a language can be picked as default. */
function audioQuality(stream: AudioStream): number {
  const tier = audioCodecTier(stream.codec, stream.profile)
  const tierScore = tier === 'universal' ? 300 : tier === 'broad' ? 200 : tier === 'limited' ? 100 : 0
  // Prefer surround over stereo for the default track, but never at the cost of
  // compatibility — hence the tier weighting dominating.
  return tierScore + Math.min(stream.channels, 8) * 5
}

export interface TrackResolution {
  /** Stream index of the track that should be the default audio, if any. */
  defaultAudioIndex?: number
  /** Language actually chosen for the default audio track. */
  defaultAudioLanguage?: string
  /** Stream index of the track that should be the default subtitle, if any. */
  defaultSubtitleIndex?: number
  /** Language fixes and flag changes to apply. */
  changes: TrackPlanChange[]
  findings: Finding[]
}

/**
 * Decide the default audio and subtitle tracks and produce the metadata
 * changes needed to get there.
 */
export function resolveTracks(file: MediaFile, settings: AppSettings, primary: PrimaryLanguage): TrackResolution {
  const changes: TrackPlanChange[] = []
  const findings: Finding[] = []

  const audio = audioStreams(file)
  const subtitles = subtitleStreams(file)
  const video = videoStreams(file)

  const primaryLanguage = primary.language
  const assumed = normalizeLanguage(settings.assumeUndefinedIs)

  /* --- 1. Fill in missing language tags ------------------------------- */

  const untagged = [...video, ...audio, ...subtitles].filter((s) => isUndefinedLanguage(s.language))
  if (untagged.length > 0) {
    findings.push({
      code: 'language-missing',
      severity: 'warning',
      remedy: 'lossless',
      title: `${untagged.length} track${untagged.length === 1 ? '' : 's'} with no language tag`,
      detail:
        'Plex cannot match untagged tracks against a client\'s language preferences, so it falls back to ' +
        `track order. Tagging them as ${languageName(assumed)} makes selection predictable.`,
      streamIndexes: untagged.map((s) => s.index)
    })
    for (const stream of untagged) {
      // Audio and subtitle tracks get the assumed language; a video stream gets
      // the primary language so it states the title's language explicitly.
      const target = stream.kind === 'video' ? primaryLanguage : assumed
      if (target === UNDEFINED_LANGUAGE) continue
      changes.push({
        streamIndex: stream.index,
        kind: stream.kind,
        setLanguage: target,
        reason: `Untagged ${stream.kind} track; tagging as ${languageName(target)}`
      })
    }
  }

  // Non-canonical tags (e.g. "en-US", "fra", "English") are rewritten to the
  // ISO 639-2/B form Matroska and Plex expect.
  const misTagged = [...video, ...audio, ...subtitles].filter(
    (s) => s.rawLanguage && !isUndefinedLanguage(s.rawLanguage) && s.rawLanguage.toLowerCase() !== s.language
  )
  if (misTagged.length > 0) {
    findings.push({
      code: 'language-nonstandard',
      severity: 'info',
      remedy: 'lossless',
      title: `${misTagged.length} track${misTagged.length === 1 ? '' : 's'} using a non-standard language tag`,
      detail:
        'Tags such as "en-US" or "English" are not the ISO 639-2 codes Plex matches on. Rewriting them to ' +
        'the canonical three-letter code makes track selection work consistently.',
      streamIndexes: misTagged.map((s) => s.index)
    })
    for (const stream of misTagged) {
      if (changes.some((c) => c.streamIndex === stream.index && c.setLanguage)) continue
      changes.push({
        streamIndex: stream.index,
        kind: stream.kind,
        setLanguage: stream.language,
        reason: `Rewriting "${stream.rawLanguage}" as "${stream.language}"`
      })
    }
  }

  /* --- 2. Pick the default audio track -------------------------------- */

  const effectiveLanguage = (stream: AudioStream | SubtitleStream): string => {
    const change = changes.find((c) => c.streamIndex === stream.index && c.setLanguage)
    return change?.setLanguage ?? stream.language
  }

  let defaultAudioIndex: number | undefined
  let defaultAudioLanguage: string | undefined

  if (audio.length === 0) {
    findings.push({
      code: 'audio-missing',
      severity: 'blocker',
      remedy: 'manual',
      title: 'No audio track',
      detail: 'The file has no audio stream. Most Plex clients will refuse to play it or play it silently.'
    })
  } else {
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
      const found = pool.filter((s) => normalizeLanguage(effectiveLanguage(s)) === language)
      if (found.length > 0) {
        candidates = found
        matchedLanguage = language
        break
      }
    }
    if (candidates.length === 0) {
      candidates = pool
      matchedLanguage = normalizeLanguage(effectiveLanguage(pool[0]))
    }

    // Keep an existing, qualifying default rather than churning the file.
    const alreadyDefault = candidates.find((s) => s.disposition.default)
    const chosen =
      alreadyDefault ?? [...candidates].sort((a, b) => audioQuality(b) - audioQuality(a) || a.index - b.index)[0]

    defaultAudioIndex = chosen.index
    defaultAudioLanguage = normalizeLanguage(effectiveLanguage(chosen))

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
        title: `Default audio is ${languageName(effectiveLanguage(current))}, not ${languageName(defaultAudioLanguage)}`,
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
  }

  /* --- 3. Pick the default subtitle track ------------------------------ */

  let defaultSubtitleIndex: number | undefined

  if (subtitles.length > 0) {
    const preferredSubLanguage = normalizeLanguage(settings.preferredSubtitleLanguage)
    const audioMatchesSubPreference = defaultAudioLanguage === preferredSubLanguage

    // Image subtitles must never be default: Plex burns them in, which turns a
    // direct play into a full video transcode.
    const usable = subtitles.filter((s) => !isImageSubtitle(s.codec))
    const inPreferred = usable.filter((s) => normalizeLanguage(effectiveLanguage(s)) === preferredSubLanguage)

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
      const streamLanguage = normalizeLanguage(effectiveLanguage(stream))
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

    // Tracks that are evidently forced but lack the flag: Plex uses the flag to
    // offer "forced subtitles only", so set it.
    const forcedButUnflagged = subtitles.filter((s) => !s.disposition.forced && looksForced(s))
    if (forcedButUnflagged.length > 0) {
      findings.push({
        code: 'forced-subtitle-not-flagged',
        severity: 'info',
        remedy: 'lossless',
        title: `${forcedButUnflagged.length} forced subtitle track${forcedButUnflagged.length === 1 ? '' : 's'} missing the forced flag`,
        detail:
          'The track title says it is forced/signs-only but the forced disposition is not set, so Plex treats ' +
          'it as a full subtitle track and will not auto-select it for foreign dialogue.',
        streamIndexes: forcedButUnflagged.map((s) => s.index)
      })
      for (const stream of forcedButUnflagged) {
        changes.push({
          streamIndex: stream.index,
          kind: 'subtitle',
          setForced: true,
          reason: `Title "${stream.title ?? ''}" indicates a forced track`
        })
      }
    }
  }

  return { defaultAudioIndex, defaultAudioLanguage, defaultSubtitleIndex, changes, findings }
}
