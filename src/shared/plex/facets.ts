/**
 * Grouping scan results by the kind of work their repair involves.
 *
 * A scan of a real library returns thousands of rows, and the useful questions
 * about it are not "which files are broken" but "which files need only a
 * retag", "which ones am I about to re-encode", "which ones are changing an
 * audio default I might disagree with". Each facet answers one of those, and a
 * file carries as many as apply.
 *
 * These are derived from the plan rather than the findings on purpose: a
 * finding says what is wrong, a plan says what will happen to the file, and
 * what the user is choosing between is what will happen.
 */

import type { AnalysisResult } from '../types.js'
import { videoStreams } from './tracks.js'

export type ResultFacet =
  | 'direct-play'
  | 'remux-only'
  | 'container'
  | 'faststart'
  | 'codec-tag'
  | 'audio-default'
  | 'subtitle-flags'
  | 'languages'
  | 'drop-tracks'
  | 'extract-subtitles'
  | 'add-aac'
  | 'transcode-video'
  | 'blocked'

/** Display order, loosely cheapest work first. */
export const FACET_ORDER: ResultFacet[] = [
  'direct-play',
  'remux-only',
  'container',
  'faststart',
  'codec-tag',
  'audio-default',
  'subtitle-flags',
  'languages',
  'drop-tracks',
  'extract-subtitles',
  'add-aac',
  'transcode-video',
  'blocked'
]

export interface FacetDescription {
  label: string
  /** Shown on hover; says what selecting this filter actually means. */
  hint: string
}

export const FACET_INFO: Record<ResultFacet, FacetDescription> = {
  'direct-play': {
    label: 'Direct plays',
    hint: 'Nothing to do — these already stream to every client without the server touching them.'
  },
  'remux-only': {
    label: 'Remux only',
    hint: 'The whole repair is a stream copy: no audio added, no video re-encoded.'
  },
  container: {
    label: 'Container change',
    hint: 'Rewrapped into a different container.'
  },
  faststart: {
    label: 'Move index to front',
    hint: 'The MP4 index sits at the end of the file, so remote clients stall before playback starts.'
  },
  'codec-tag': {
    label: 'Codec retag',
    hint: 'The video codec tag is corrected — for example HEVC as hvc1, which Apple clients require.'
  },
  'audio-default': {
    label: 'Default audio change',
    hint: 'The track that plays by default changes. Worth reviewing before running these.'
  },
  'subtitle-flags': {
    label: 'Subtitle flag change',
    hint: 'A subtitle track has its default or forced flag changed.'
  },
  languages: {
    label: 'Language tags',
    hint: 'Missing or non-standard language tags are rewritten to ISO 639-2.'
  },
  'drop-tracks': {
    label: 'Drops a track',
    hint: 'A track the target container cannot carry is left out of the output.'
  },
  'extract-subtitles': {
    label: 'Extracts subtitles',
    hint: 'Subtitles are written out as .srt sidecars beside the file.'
  },
  'add-aac': {
    label: 'Adds AAC track',
    hint: 'Nothing in the file is universally playable, so an AAC track is added alongside the originals.'
  },
  'transcode-video': {
    label: 'Re-encodes video',
    hint: 'A stream copy cannot fix this file at the configured target: the video has to be re-encoded.'
  },
  blocked: {
    label: 'Needs you',
    hint: 'Something here cannot be repaired automatically.'
  }
}

/** Every facet that applies to one result. */
export function facetsFor(result: AnalysisResult): Set<ResultFacet> {
  const { plan, file } = result
  const facets = new Set<ResultFacet>()

  if (plan.unresolved.some((finding) => finding.severity !== 'info')) facets.add('blocked')

  if (plan.strategy === 'none') {
    facets.add('direct-play')
    return facets
  }

  if (plan.strategy === 'remux') facets.add('remux-only')
  if (plan.targetContainer !== file.container) facets.add('container')
  if (plan.faststart && file.faststart === false) facets.add('faststart')

  // Only a tag that actually changes counts: the plan carries the tag the
  // output should have, which is usually the one it already has.
  const primaryVideo = videoStreams(file)[0]
  if (plan.videoCodecTag && plan.videoCodecTag.toLowerCase() !== primaryVideo?.codecTag?.toLowerCase()) {
    facets.add('codec-tag')
  }

  for (const change of plan.trackChanges) {
    if (change.drop) facets.add('drop-tracks')
    if (change.setLanguage != null) facets.add('languages')
    if (change.kind === 'audio' && change.setDefault != null) facets.add('audio-default')
    if (change.kind === 'subtitle' && (change.setDefault != null || change.setForced != null)) {
      facets.add('subtitle-flags')
    }
  }

  if (plan.extractSubtitles.length > 0) facets.add('extract-subtitles')
  if (plan.addCompatibilityAudio) facets.add('add-aac')
  if (plan.videoTranscode || plan.requiresTranscode) facets.add('transcode-video')

  return facets
}

/** How many results carry each facet, for the counts on the filter chips. */
export function countFacets(results: AnalysisResult[]): Record<ResultFacet, number> {
  const counts = Object.fromEntries(FACET_ORDER.map((facet) => [facet, 0])) as Record<ResultFacet, number>
  for (const result of results) {
    for (const facet of facetsFor(result)) counts[facet]++
  }
  return counts
}

/**
 * Results matching any of the active facets.
 *
 * Any rather than all: the chips are a way of saying "show me these kinds of
 * file", and intersecting them mostly produces an empty table.
 */
export function filterResults(results: AnalysisResult[], active: Set<ResultFacet>): AnalysisResult[] {
  if (active.size === 0) return results
  return results.filter((result) => {
    const facets = facetsFor(result)
    for (const facet of active) if (facets.has(facet)) return true
    return false
  })
}
