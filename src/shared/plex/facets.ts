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
import { isBlocked } from './blocked.js'

// Lives beside the explanations it decides on; re-exported for existing callers.
export { needsYou } from './blocked.js'
import { videoStreams } from './tracks.js'

export type ResultFacet =
  | 'direct-play'
  | 'fixable'
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

/**
 * Display order: the three answers to "can this be fixed?" first, then the
 * kinds of work, loosely cheapest first.
 */
export const FACET_ORDER: ResultFacet[] = [
  'direct-play',
  'fixable',
  'blocked',
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
  'transcode-video'
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
  fixable: {
    label: 'Fixable',
    hint: 'PlexFixer can repair these: a stream copy, or a re-encode where nothing else will do.'
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
    label: 'Blocked',
    hint: 'Something here has no automatic repair. Open a row to see why, and what you can do about it.'
  }
}

/** Every facet that applies to one result. */
export function facetsFor(result: AnalysisResult): Set<ResultFacet> {
  const { plan, file } = result
  const facets = new Set<ResultFacet>()

  const blocked = isBlocked(result)
  if (blocked) facets.add('blocked')
  // Fixable and blocked are the two halves of "will PlexFixer deal with this?",
  // so nothing carries both: a file with an unresolved blocker is blocked even
  // when the plan would also fix three other things about it.
  if (!blocked && plan.strategy !== 'none') facets.add('fixable')

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
  // Every facet, including any not shown as a chip, so each count starts at 0.
  const counts = Object.fromEntries(Object.keys(FACET_INFO).map((facet) => [facet, 0])) as Record<ResultFacet, number>
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

/* ------------------------------------------------------------------ *
 * File status — the status column and the summary tiles above the table
 * ------------------------------------------------------------------ */

/**
 * What happens next for a file, as one word. Every file has exactly one, so the
 * tiles never overlap and add up to the library.
 *
 * - passed:   nothing to do; direct plays as it is, perhaps with advisory notes
 * - manual:   something only the user can sort out ("blocked"); see `needsYou`
 * - reencode: only a video re-encode fixes it
 * - fixable:  a lossless remux (perhaps with an added AAC track) fixes it
 *
 * This is about the decision in front of the user, which is what a table of
 * thousands needs; the severity of every finding is still in the detail pane.
 */
export type FileStatus = 'passed' | 'fixable' | 'reencode' | 'manual'

export const STATUS_ORDER: FileStatus[] = ['passed', 'fixable', 'reencode', 'manual']

export function fileStatus(result: AnalysisResult): FileStatus {
  if (result.verdict === 'ok') return 'passed'
  // Same rule as the "blocked" facet and the detail pane's explanations.
  if (isBlocked(result)) return 'manual'
  if (result.plan.requiresTranscode) return 'reencode'
  if (result.plan.strategy !== 'none') return 'fixable'
  // Only advisory warnings are left, and the repair has nothing to change.
  return 'passed'
}

export function matchesStatus(result: AnalysisResult, status: FileStatus): boolean {
  return fileStatus(result) === status
}

/** Counts for the tiles, from the same rule the filter uses. */
export function countStatuses(results: AnalysisResult[]): Record<FileStatus, number> {
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0])) as Record<FileStatus, number>
  for (const result of results) counts[fileStatus(result)]++
  return counts
}
