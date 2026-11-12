/**
 * Narrowing the table by codec: the video codec the Technical column shows,
 * and the audio codecs a file carries.
 *
 * Video goes by the one real video track (cover art excluded), as shown in the
 * row. Audio goes by every track, so "DTS" finds a file whose DTS track is not
 * the default — the question being answered is "which files carry DTS".
 */

import type { AnalysisResult } from '../types.js'
import { audioStreams, videoStreams } from './tracks.js'

export type CodecKind = 'video' | 'audio'

/** The ticked codecs in each picker; an empty set means no restriction. */
export type CodecFilter = Record<CodecKind, Set<string>>

export type CodecCounts = Record<CodecKind, Map<string, number>>

/** Lowercased, with every PCM variant as one "pcm" so the list is not split per sample format. */
export function codecKey(codec: string): string {
  const key = codec.toLowerCase()
  return key.startsWith('pcm_') ? 'pcm' : key
}

export function videoCodecOf(result: AnalysisResult): string | undefined {
  const codec = videoStreams(result.file)[0]?.codec
  return codec ? codecKey(codec) : undefined
}

export function audioCodecsOf(result: AnalysisResult): Set<string> {
  return new Set(audioStreams(result.file).map((stream) => codecKey(stream.codec)))
}

function matchesVideo(result: AnalysisResult, wanted: Set<string>): boolean {
  if (wanted.size === 0) return true
  const codec = videoCodecOf(result)
  return codec !== undefined && wanted.has(codec)
}

function matchesAudio(result: AnalysisResult, wanted: Set<string>): boolean {
  if (wanted.size === 0) return true
  for (const codec of audioCodecsOf(result)) if (wanted.has(codec)) return true
  return false
}

/**
 * Results matching the filter: any ticked codec within a picker, and both
 * pickers together — HEVC and H.264 widens, HEVC and DTS narrows to HEVC files
 * carrying DTS.
 */
export function filterByCodec(results: AnalysisResult[], filter: CodecFilter): AnalysisResult[] {
  if (filter.video.size === 0 && filter.audio.size === 0) return results
  return results.filter((result) => matchesVideo(result, filter.video) && matchesAudio(result, filter.audio))
}

/**
 * How many results carry each codec. Each picker counts against the other
 * picker's selection but not its own, so a count says what ticking that box
 * would add.
 */
export function countCodecs(results: AnalysisResult[], filter: CodecFilter): CodecCounts {
  const counts: CodecCounts = { video: new Map(), audio: new Map() }
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  for (const result of results) {
    if (matchesAudio(result, filter.audio)) {
      const codec = videoCodecOf(result)
      if (codec) bump(counts.video, codec)
    }
    if (matchesVideo(result, filter.video)) {
      for (const codec of audioCodecsOf(result)) bump(counts.audio, codec)
    }
  }
  return counts
}

export function emptyCodecFilter(): CodecFilter {
  return { video: new Set(), audio: new Set() }
}

export function codecFilterActive(filter: CodecFilter): boolean {
  return filter.video.size > 0 || filter.audio.size > 0
}
