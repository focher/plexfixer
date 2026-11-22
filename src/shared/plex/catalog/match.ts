/**
 * Reading a file through the catalog: which flags it carries, which status it
 * falls under, and which chips it answers to.
 */

import type { AnalysisResult, Finding } from '../../types.js'
import { flagDef } from './resolve.js'
import type { Catalog, FlagSelector, StatusDef, StatusMatch } from './types.js'

/** Findings are compared by what they say, so a result that crossed a process boundary still matches. */
const findingKey = (finding: Finding): string =>
  `${finding.code}|${finding.title}|${(finding.streamIndexes ?? []).join(',')}`

/** The flag ids a file carries, each once, in the order first raised. */
export const flagsOf = (result: AnalysisResult): string[] => [...new Set(result.findings.map((finding) => finding.code))]

function selects(selector: FlagSelector, finding: Finding, catalog: Catalog, unresolved: ReadonlySet<string>): boolean {
  const def = flagDef(catalog, finding.code)
  return (
    (selector.flag === undefined || selector.flag.includes(finding.code)) &&
    (selector.category === undefined || selector.category.includes(def.category)) &&
    (selector.severity === undefined || selector.severity.includes(finding.severity)) &&
    (selector.remedy === undefined || selector.remedy.includes(finding.remedy)) &&
    (selector.repair === undefined || selector.repair.includes(def.repair)) &&
    (selector.unresolved === undefined || selector.unresolved === unresolved.has(findingKey(finding)))
  )
}

/** Whether a condition holds for one file. */
export function matchesCondition(match: StatusMatch, result: AnalysisResult, catalog: Catalog): boolean {
  const unresolved = new Set(result.plan.unresolved.map(findingKey))
  const anySelects = (selector: FlagSelector): boolean =>
    result.findings.some((finding) => selects(selector, finding, catalog, unresolved))

  const holds = (condition: StatusMatch): boolean => {
    if ('any' in condition) return condition.any.some(anySelects)
    if ('all' in condition) return condition.all.every(anySelects)
    if ('none' in condition) return !condition.none.some(anySelects)
    if ('strategy' in condition) return condition.strategy.includes(result.plan.strategy)
    if ('always' in condition) return condition.always
    if ('and' in condition) return condition.and.every(holds)
    if ('or' in condition) return condition.or.some(holds)
    return !holds(condition.not)
  }

  return holds(match)
}

/** The first status whose rule matches; the last status when none does. */
export function statusIdOf(result: AnalysisResult, catalog: Catalog): string {
  const rule = catalog.statusRules.find((candidate) => matchesCondition(candidate.when, result, catalog))
  return rule?.status ?? catalog.statuses[catalog.statuses.length - 1]?.id ?? ''
}

export function statusDefOf(result: AnalysisResult, catalog: Catalog): StatusDef | undefined {
  const id = statusIdOf(result, catalog)
  return catalog.statuses.find((status) => status.id === id)
}

/** How many files fall under each status, every status present and starting at 0. */
export function countStatusIds(results: readonly AnalysisResult[], catalog: Catalog): Record<string, number> {
  return results.reduce<Record<string, number>>(
    (counts, result) => {
      const id = statusIdOf(result, catalog)
      return { ...counts, [id]: (counts[id] ?? 0) + 1 }
    },
    Object.fromEntries(catalog.statuses.map((status) => [status.id, 0]))
  )
}

/** Whether a file's status is one "Hide passed" hides. */
export const isPassing = (result: AnalysisResult, catalog: Catalog): boolean =>
  statusDefOf(result, catalog)?.passing ?? false

/** How many files carry each flag, for the chips. Only flags present appear. */
export function countFlags(results: readonly AnalysisResult[]): Map<string, number> {
  return results.reduce(
    (counts, result) => flagsOf(result).reduce((inner, flag) => inner.set(flag, (inner.get(flag) ?? 0) + 1), counts),
    new Map<string, number>()
  )
}

/**
 * Files carrying any of the active flags.
 *
 * Any rather than all: the chips are a way of saying "show me these kinds of
 * file", and intersecting them mostly produces an empty table.
 */
export function filterByFlags(results: AnalysisResult[], active: ReadonlySet<string>): AnalysisResult[] {
  if (active.size === 0) return results
  return results.filter((result) => result.findings.some((finding) => active.has(finding.code)))
}
