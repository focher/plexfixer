/**
 * The status tiles and the filter chips, read through the catalog.
 *
 * Both used to be written out here: a fixed list of "kinds of work" chips
 * derived from the plan, and four statuses decided by a chain of `if`s. Both
 * are now data — the chips are the flags a file carries, and the statuses are
 * the ordered rules in the catalog — so this file only puts names on them for
 * the rest of the app. The shipped rules in `default.json` give exactly the
 * statuses the chain of `if`s used to.
 */

import type { AnalysisResult } from '../types.js'
import { DEFAULT_CATALOG } from './catalog/resolve.js'
import { countStatusIds, isPassing, statusIdOf } from './catalog/match.js'
import type { Catalog } from './catalog/types.js'
import { isBlocked } from './blocked.js'

// Lives beside the explanations it decides on; re-exported for existing callers.
export { needsYou } from './blocked.js'
export { countFlags, filterByFlags, flagsOf } from './catalog/match.js'

/**
 * What happens next for a file, as one word: the id of one of the catalog's
 * statuses. Every file has exactly one, so the tiles never overlap and add up
 * to the library. The shipped ids are `passed`, `fixable`, `reencode` and
 * `manual`; a user's catalog may have others.
 */
export type FileStatus = string

/** The shipped status ids, in display order. */
export const STATUS_ORDER: FileStatus[] = DEFAULT_CATALOG.statuses.map((status) => status.id)

export const fileStatus = (result: AnalysisResult, catalog: Catalog = DEFAULT_CATALOG): FileStatus =>
  statusIdOf(result, catalog)

export const matchesStatus = (result: AnalysisResult, status: FileStatus, catalog: Catalog = DEFAULT_CATALOG): boolean =>
  fileStatus(result, catalog) === status

/** Counts for the tiles, from the same rules the filter uses. */
export const countStatuses = (results: AnalysisResult[], catalog: Catalog = DEFAULT_CATALOG): Record<FileStatus, number> =>
  countStatusIds(results, catalog)

/** Whether "Hide passed" hides this file. */
export const isPassed = (result: AnalysisResult, catalog: Catalog = DEFAULT_CATALOG): boolean =>
  isPassing(result, catalog)

/**
 * Whether only a video re-encode fixes the file.
 *
 * Asked by the "set these to Force transcode" suggestion, which is about the
 * plan rather than about how the user has chosen to label it, so it does not
 * go through the status rules.
 */
export const needsReencode = (result: AnalysisResult): boolean =>
  result.verdict !== 'ok' && !isBlocked(result) && result.plan.requiresTranscode
