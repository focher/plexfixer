/**
 * The catalog: every tunable part of what a scan reports and what a repair does.
 *
 * The checks and repairs are code, but everything about how their output is
 * *used* is data: which flags a check keeps, what each flag is called on its
 * chip, which repair answers it, and which flags put a file under which status
 * tile. That data ships as `default.json` and the user's changes are stored as
 * a sparse patch over it, so "Reset" is deleting the patch and a test can load
 * the shipped defaults as plain JSON.
 *
 * A flag is a finding code. A check raises flags; a flag is answered by at most
 * one repair; the status tiles are rules over the flags a file carries.
 */

import type { FindingCode, PlanStrategy, RemedyClass, Severity } from '../../types.js'

export type FlagId = FindingCode

/** Where a flag's chip is grouped in the filter bar. */
export type FlagCategory = 'file' | 'video' | 'audio' | 'container' | 'subtitle' | 'tracks' | 'custom'

export const FLAG_CATEGORY_ORDER: readonly FlagCategory[] = [
  'file',
  'video',
  'audio',
  'container',
  'subtitle',
  'tracks',
  'custom'
]

export const FLAG_CATEGORY_LABEL: Readonly<Record<FlagCategory, string>> = {
  file: 'File',
  video: 'Video',
  audio: 'Audio',
  container: 'Container',
  subtitle: 'Subtitles',
  tracks: 'Tracks',
  custom: 'Your rules'
}

export type ParamValue = number | boolean | string | readonly string[]

export interface CheckEntry {
  enabled: boolean
  params: Readonly<Record<string, ParamValue>>
}

export interface RepairEntry {
  enabled: boolean
  params: Readonly<Record<string, ParamValue>>
  /** Re-run the checks on the repaired file, so its row is current without a rescan. */
  recheck: boolean
}

export interface FlagDef {
  /** The chip's text. */
  label: string
  /** The chip's tooltip. */
  hint: string
  category: FlagCategory
  /**
   * False discards the flag: the check still runs (it is one pass over the
   * file either way), but the finding is dropped, so it has no chip, no
   * status, and no repair.
   */
  keep: boolean
  /** False keeps the flag but leaves it out of the chip row. */
  chip: boolean
  /** Overrides the severity the check gave the finding; null leaves it to the check. */
  severity: Severity | null
  /** The one repair that answers this flag, or null to only report it. */
  repair: string | null
}

/** One tile in the summary row and one badge in the status column. */
export interface StatusDef {
  id: string
  label: string
  /** The short form shown in the table's status column. */
  badge: string
  hint: string
  tone: 'ok' | 'info' | 'warn' | 'fail' | 'neutral'
  /** Files under this status are the ones "Hide passed" hides. */
  passing: boolean
}

/**
 * Picks findings. Every field that is present has to match; an empty selector
 * matches every finding.
 */
export interface FlagSelector {
  flag?: readonly FlagId[]
  category?: readonly FlagCategory[]
  severity?: readonly Severity[]
  remedy?: readonly RemedyClass[]
  /** The repair the flag is bound to; null matches report-only flags. */
  repair?: readonly (string | null)[]
  /** Whether the plan leaves the finding unfixed. */
  unresolved?: boolean
}

/** A condition over one file: its flags, and the plan made for it. */
export type StatusMatch =
  | { any: readonly FlagSelector[] }
  | { all: readonly FlagSelector[] }
  | { none: readonly FlagSelector[] }
  | { strategy: readonly PlanStrategy[] }
  | { always: true }
  | { and: readonly StatusMatch[] }
  | { or: readonly StatusMatch[] }
  | { not: StatusMatch }

/** Which status a file gets: the first rule that matches wins. */
export interface StatusRule {
  status: string
  when: StatusMatch
}

export interface Catalog {
  version: 1
  checks: Readonly<Record<string, CheckEntry>>
  repairs: Readonly<Record<string, RepairEntry>>
  flags: Readonly<Record<string, FlagDef>>
  /** In display order. */
  statuses: readonly StatusDef[]
  /** In evaluation order; the last should always match. */
  statusRules: readonly StatusRule[]
}

/**
 * What the user changed. Entries merge field by field over the defaults;
 * `statuses` and `statusRules`, when present, replace the shipped lists whole,
 * because an ordered list has no sensible field-by-field merge.
 */
export interface CatalogPatch {
  checks?: Record<string, Partial<CheckEntry>>
  repairs?: Record<string, Partial<RepairEntry>>
  flags?: Record<string, Partial<FlagDef>>
  statuses?: StatusDef[]
  statusRules?: StatusRule[]
}
