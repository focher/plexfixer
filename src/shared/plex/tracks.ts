/**
 * Reading a file's tracks: what is in it, and what each track is.
 *
 * Everything here is a question with one answer and no opinions — which
 * streams are really video rather than a poster, whether a track's title says
 * "commentary", what language the film is in. The decisions built on top of
 * those answers live in the track modules under `modules/checks`, which all
 * start here.
 */

import type {
  AudioStream,
  MediaFile,
  MediaStream,
  SubtitleStream,
  VideoStream,
  AppSettings
} from '../types.js'
import { UNDEFINED_LANGUAGE, isUndefinedLanguage, normalizeLanguage } from '../languages.js'
import { audioCodecTier } from './rules.js'

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

/** The audio track that plays by default: the flagged one, else the first. */
export function defaultAudioStream(file: MediaFile): AudioStream | undefined {
  const audio = audioStreams(file)
  return audio.find((s) => s.disposition.default) ?? audio[0]
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
export function audioQuality(stream: AudioStream): number {
  const tier = audioCodecTier(stream.codec, stream.profile)
  const tierScore = tier === 'universal' ? 300 : tier === 'broad' ? 200 : tier === 'limited' ? 100 : 0
  // Prefer surround over stereo for the default track, but never at the cost of
  // compatibility — hence the tier weighting dominating.
  return tierScore + Math.min(stream.channels, 8) * 5
}
