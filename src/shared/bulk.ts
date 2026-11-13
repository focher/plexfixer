/**
 * What a bulk repair will actually do, file by file, before it is queued.
 *
 * "Force transcode" does not re-encode everything it is given: it *allows* a
 * re-encode where the plan needs one, and every other file gets the same
 * lossless repair it would have had anyway. A confirmation that just said
 * "Force transcode 12 files?" read as if all twelve were about to be
 * re-encoded, so this counts each outcome instead.
 *
 * The order of the checks mirrors `RepairRunner.enqueue` in
 * src/main/jobs/runner.ts — report-only, then nothing to do, then a needed
 * re-encode the mode does not allow — so the prompt and the Jobs tab agree.
 */

import type { AnalysisResult, ModeOverrides, RepairMode } from './types.js'
import { MODE_LABEL, repairModeFor } from './mode.js'

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
 * The confirmation for a bulk repair, or undefined when none is needed.
 *
 * Only a batch that re-encodes asks: that is the slow, lossy part, and the one
 * a click should not start by accident. A single file (the row's own button)
 * never asks.
 */
export function repairConfirmation(summary: RepairSummary, total: number, mode?: RepairMode): string | undefined {
  if (total <= 1 || summary.reencode === 0) return undefined
  const action = mode ? MODE_LABEL[mode] : 'Repair'
  const lines = [
    summary.reencode > 0 &&
      `${plural(summary.reencode, 'file', 'files')} will have ${summary.reencode === 1 ? 'its' : 'their'} video re-encoded. This is slow, and it is not lossless.`,
    summary.lossless > 0 &&
      `${plural(summary.lossless, 'file only needs', 'files only need')} a lossless remux and will be remuxed, not re-encoded.`,
    summary.needsReencodeSkipped > 0 &&
      `${plural(summary.needsReencodeSkipped, 'file needs', 'files need')} a re-encode ${summary.needsReencodeSkipped === 1 ? 'its' : 'their'} mode does not allow, and will be skipped.`,
    summary.nothingToDo > 0 &&
      `${plural(summary.nothingToDo, 'file has', 'files have')} nothing to do and will be skipped.`,
    summary.reportOnly > 0 &&
      `${plural(summary.reportOnly, 'file is', 'files are')} set to Report only and will be skipped.`
  ].filter(Boolean)
  return `${action} ${plural(total, 'file', 'files')}?\n\n${lines.join('\n')}`
}
