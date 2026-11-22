/**
 * Status rules in plain English, for the editor to show beside each one.
 *
 * The rules are a small tree of conditions; a person building one with
 * dropdowns needs to see what it now says, not what shape it is.
 */

import type { PlanStrategy, RemedyClass, Severity } from '../../types.js'
import { flagDef } from './resolve.js'
import { FLAG_CATEGORY_LABEL, type Catalog, type FlagSelector, type StatusMatch } from './types.js'

export const STRATEGY_LABEL: Readonly<Record<PlanStrategy, string>> = {
  none: 'nothing to do',
  remux: 'a remux',
  'transcode-audio': 'a remux and an added audio track',
  'transcode-video': 'a video re-encode'
}

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  info: 'info',
  warning: 'warning',
  blocker: 'blocker'
}

export const REMEDY_LABEL: Readonly<Record<RemedyClass, string>> = {
  lossless: 'fixable losslessly',
  transcode: 'needs a re-encode',
  manual: 'needs a person',
  none: 'needs nothing'
}

const either = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`

/** "a warning or blocker flag that is not fixed", and so on. */
export function describeSelector(selector: FlagSelector, catalog: Catalog): string {
  const parts = [
    selector.flag?.length ? `“${either(selector.flag.map((flag) => flagDef(catalog, flag).label))}”` : undefined,
    selector.severity?.length ? either(selector.severity.map((s) => SEVERITY_LABEL[s])) : undefined,
    selector.category?.length ? either(selector.category.map((c) => FLAG_CATEGORY_LABEL[c].toLowerCase())) : undefined
  ].filter((part): part is string => part !== undefined)
  const extras = [
    selector.remedy?.length ? `that ${either(selector.remedy.map((r) => REMEDY_LABEL[r]))}` : undefined,
    selector.repair?.length
      ? `answered by ${either(selector.repair.map((r) => (r === null ? 'nothing (report only)' : r)))}`
      : undefined,
    selector.unresolved === true ? 'that the plan does not fix' : undefined,
    selector.unresolved === false ? 'that the plan fixes' : undefined
  ].filter((part): part is string => part !== undefined)
  return [`${parts.length > 0 ? parts.join(' ') : 'any'} flag`, ...extras].join(' ')
}

export function describeMatch(match: StatusMatch, catalog: Catalog): string {
  const selectors = (list: readonly FlagSelector[]): string => either(list.map((s) => describeSelector(s, catalog)))
  if ('any' in match) {
    return match.any.length === 0 ? 'never' : `it has ${either(match.any.map((sel) => `a ${describeSelector(sel, catalog)}`))}`
  }
  if ('all' in match) return `it has each of: ${match.all.map((s) => describeSelector(s, catalog)).join('; ')}`
  if ('none' in match) return match.none.length === 0 ? 'always' : `it has no ${selectors(match.none)}`
  if ('strategy' in match) return `the plan is ${either(match.strategy.map((s) => STRATEGY_LABEL[s]))}`
  if ('always' in match) return 'always'
  if ('and' in match) return match.and.map((inner) => `(${describeMatch(inner, catalog)})`).join(' and ')
  if ('or' in match) return match.or.map((inner) => `(${describeMatch(inner, catalog)})`).join(' or ')
  return `not (${describeMatch(match.not, catalog)})`
}
