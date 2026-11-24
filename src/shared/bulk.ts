/**
 * What a bulk repair will actually do, file by file, before it is queued.
 *
 * "Force transcode" does not re-encode everything it is given: it *allows* a
 * re-encode where the plan needs one, and every other file gets the same
 * lossless repair it would have had anyway. A confirmation that just said
 * "Force transcode 12 files?" read as if all twelve were about to be
 * re-encoded, so this counts each outcome instead, and `RepairDialog` says
 * the counts back before anything is queued.
 *
 * The order of the checks mirrors `RepairRunner.enqueue` in
 * src/main/jobs/runner.ts — report-only, then nothing to do, then a needed
 * re-encode the mode does not allow — so the prompt and the Jobs tab agree.
 */

import type { AnalysisResult, ModeOverrides, RepairMode } from './types.js'
import { repairModeFor } from './mode.js'

export interface RepairSummary {
  /** Files whose video will be re-encoded. */
  reencode: number
  /** Files that get a lossless repair (a remux, perhaps with an added AAC track). */
  lossless: number
  /** Files that need a re-encode their mode does not allow; the runner skips them. */
  needsReencodeSkipped: number
  /** Files that already direct play. */
  nothingToDo: number
  /** Files set to Report only, which nothing writes to. */
  reportOnly: number
}

export function summarizeRepair(
  results: AnalysisResult[],
  overrides: ModeOverrides,
  defaultMode: RepairMode,
  mode?: RepairMode
): RepairSummary {
  const summary: RepairSummary = { reencode: 0, lossless: 0, needsReencodeSkipped: 0, nothingToDo: 0, reportOnly: 0 }
  for (const result of results) {
    const resolved = repairModeFor(result.file.path, overrides, defaultMode, mode)
    if (resolved === 'report') summary.reportOnly++
    else if (result.plan.strategy === 'none') summary.nothingToDo++
    else if (result.plan.requiresTranscode) {
      if (resolved === 'force-transcode') summary.reencode++
      else summary.needsReencodeSkipped++
    } else summary.lossless++
  }
  return summary
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/**
 * What a run will do to its files, one sentence per outcome.
 *
 * Shared by the dialog that asks before a re-encode and by the plain-text
 * confirmation: two wordings of the same count is how a prompt comes to
 * disagree with the Jobs tab.
 */
export function repairOutcomes(
  summary: RepairSummary,
  /**
   * Whether a naming pattern is set. A file with nothing wrong with it is not
   * skipped outright then: if its name does not match the pattern it is
   * renamed, which is a move and nothing more.
   */
  mayRename = false
): string[] {
  return [
    summary.reencode > 0 &&
      `${plural(summary.reencode, 'file', 'files')} will have ${summary.reencode === 1 ? 'its' : 'their'} video re-encoded. This is slow, and it is not lossless.`,
    summary.lossless > 0 &&
      `${plural(summary.lossless, 'file only needs', 'files only need')} a lossless remux and will be remuxed, not re-encoded.`,
    summary.needsReencodeSkipped > 0 &&
      `${plural(summary.needsReencodeSkipped, 'file needs', 'files need')} a re-encode ${summary.needsReencodeSkipped === 1 ? 'its' : 'their'} mode does not allow, and will be skipped.`,
    summary.nothingToDo > 0 &&
      (mayRename
        ? `${plural(summary.nothingToDo, 'file has', 'files have')} nothing to repair, and will only be renamed if the naming pattern asks for it.`
        : `${plural(summary.nothingToDo, 'file has', 'files have')} nothing to do and will be skipped.`),
    summary.reportOnly > 0 &&
      `${plural(summary.reportOnly, 'file is', 'files are')} set to Report only and will be skipped.`
  ].filter((line): line is string => typeof line === 'string')
}
