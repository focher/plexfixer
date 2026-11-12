/**
 * Ordering the library table.
 *
 * Sorting is done on a decorated copy: `summarizeReason` is not free, and a
 * comparator that calls it runs it O(n log n) times on a library of thousands.
 * Every sort falls back to the path, so rows never shuffle between renders and
 * two files that tie are always in the same order.
 */

import type { AnalysisResult, PlanStrategy } from './types.js'
import { STATUS_ORDER, fileStatus } from './plex/facets.js'
import { summarizeReason } from './plex/reason.js'

export type SortKey = 'status' | 'name' | 'reason' | 'plan' | 'size' | 'scanned'
export type SortDirection = 'asc' | 'desc'

export interface SortState {
  key: SortKey
  direction: SortDirection
}

export const DEFAULT_SORT: SortState = { key: 'name', direction: 'asc' }

/**
 * What a first click on each column should mean.
 *
 * Text reads naturally A→Z, but nobody clicks "Size" to see the smallest file
 * or "Scanned" to see the oldest — those start at the end that is interesting.
 */
export const FIRST_DIRECTION: Record<SortKey, SortDirection> = {
  status: 'asc',
  name: 'asc',
  reason: 'asc',
  plan: 'asc',
  size: 'desc',
  scanned: 'desc'
}

/** Cheapest work first, so "Plan" ascending runs from nothing-to-do to re-encode. */
const PLAN_ORDER: Record<PlanStrategy, number> = {
  none: 0,
  remux: 1,
  'transcode-audio': 2,
  'transcode-video': 3
}

function keyFor(result: AnalysisResult, key: SortKey): string | number {
  switch (key) {
    case 'status':
      return STATUS_ORDER.indexOf(fileStatus(result))
    case 'reason':
      return summarizeReason(result).headline.toLowerCase()
    case 'plan':
      return PLAN_ORDER[result.plan.strategy]
    case 'size':
      return result.file.sizeBytes
    case 'scanned':
      return result.scannedAt ?? 0
    case 'name':
    default:
      // By name, not by path: two files called the same in different folders
      // belong next to each other, which is the point of sorting by name.
      return result.file.fileName.toLowerCase()
  }
}

export function sortResults(results: AnalysisResult[], sort: SortState): AnalysisResult[] {
  const sign = sort.direction === 'desc' ? -1 : 1
  return results
    .map((result) => ({ result, key: keyFor(result, sort.key), path: result.file.path }))
    .sort((a, b) => {
      const comparison =
        typeof a.key === 'number' && typeof b.key === 'number'
          ? a.key - b.key
          : String(a.key).localeCompare(String(b.key))
      if (comparison !== 0) return comparison * sign
      return a.path.localeCompare(b.path)
    })
    .map((entry) => entry.result)
}

/** Clicking a column: the same column flips, a new one starts at its natural end. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, direction: FIRST_DIRECTION[key] }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
}
