/**
 * Checking a repaired file again.
 *
 * Each repair says, in the catalog, whether the checks should be run again on
 * what it wrote. When any repair a job used asks for it, the runner probes the
 * finished file, analyses it with the same settings, and reports which of the
 * flags the job set out to fix are still there. Nothing is repaired a second
 * time on the strength of that — a repair that did not take is reported, not
 * retried, so a file can never be caught in a loop.
 */

import type { AnalysisResult, AppSettings, FindingCode } from '../types.js'
import { catalogFor, flagDef } from './catalog/resolve.js'

const unresolvedCodes = (result: AnalysisResult): Set<FindingCode> =>
  new Set(result.plan.unresolved.map((finding) => finding.code))

/** The flags a job set out to fix: raised, and not left unresolved by its plan. */
export function flagsToFix(result: AnalysisResult): FindingCode[] {
  const unresolved = unresolvedCodes(result)
  return [...new Set(result.findings.map((finding) => finding.code))].filter((code) => !unresolved.has(code))
}

/** The repairs answering those flags, by id. */
export function repairsUsed(result: AnalysisResult, settings: Pick<AppSettings, 'catalog'>): string[] {
  const catalog = catalogFor(settings)
  return [
    ...new Set(
      flagsToFix(result)
        .map((code) => flagDef(catalog, code).repair)
        .filter((repair): repair is string => repair !== null)
    )
  ]
}

/**
 * Whether to check the file again once it is written.
 *
 * Yes when any repair the job used asks for it. A job that only carried out
 * repairs no flag points at — the consequences of the plan, like dropping cover
 * art — follows the repairs' default, which is to check.
 */
export function wantsRecheck(result: AnalysisResult, settings: Pick<AppSettings, 'catalog'>): boolean {
  const catalog = catalogFor(settings)
  const used = repairsUsed(result, settings)
  return used.length === 0 || used.some((repair) => catalog.repairs[repair]?.recheck !== false)
}

/** Flags the job meant to fix that the repaired file still carries. */
export function remainingFlags(before: AnalysisResult, after: AnalysisResult): FindingCode[] {
  const meant = new Set(flagsToFix(before))
  return [...new Set(after.findings.map((finding) => finding.code))].filter((code) => meant.has(code))
}
