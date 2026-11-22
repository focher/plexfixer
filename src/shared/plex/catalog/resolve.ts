/**
 * Turning `default.json` and the user's patch into the catalog a run uses.
 *
 * Everything here is pure, and nothing trusts its input: the defaults are
 * checked the same way an imported patch is, so a bad edit to `default.json`
 * fails its test rather than a scan, and a patch written by an older build (or
 * by hand) loses only the entries that no longer make sense.
 */

import type { AppSettings, PlanStrategy, RemedyClass, Severity } from '../../types.js'
import defaultJson from './default.json'
import { isCheckScriptFlag, isCheckScriptId, isScriptRepairId } from '../scripts/manifest.js'
import {
  FLAG_CATEGORY_ORDER,
  type Catalog,
  type CatalogPatch,
  type CheckEntry,
  type FlagCategory,
  type FlagDef,
  type FlagSelector,
  type ParamValue,
  type RepairEntry,
  type StatusDef,
  type StatusMatch,
  type StatusRule
} from './types.js'

export interface CatalogResult {
  catalog: Catalog
  /** What was wrong and left out, one line each, for Settings and the tests. */
  problems: string[]
}

/* ------------------------------------------------------------------ *
 * Shape checks
 * ------------------------------------------------------------------ */

const SEVERITIES: readonly Severity[] = ['info', 'warning', 'blocker']
const REMEDIES: readonly RemedyClass[] = ['lossless', 'transcode', 'manual', 'none']
const STRATEGIES: readonly PlanStrategy[] = ['none', 'remux', 'transcode-audio', 'transcode-video']
const TONES: readonly StatusDef['tone'][] = ['ok', 'info', 'warn', 'fail', 'neutral']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  isString(value) && (options as readonly string[]).includes(value)

const isParamValue = (value: unknown): boolean =>
  typeof value === 'number' || typeof value === 'boolean' || isString(value) || isStringList(value)

const isParams = (value: unknown): value is CheckEntry['params'] =>
  isRecord(value) && Object.values(value).every(isParamValue)

/** Problems with one selector; empty when it is fine. */
function selectorProblems(selector: unknown, at: string): string[] {
  if (!isRecord(selector)) return [`${at}: a selector must be an object`]
  const known = ['flag', 'category', 'severity', 'remedy', 'repair', 'unresolved']
  return [
    ...Object.keys(selector)
      .filter((key) => !known.includes(key))
      .map((key) => `${at}: unknown selector field "${key}"`),
    ...(selector.flag !== undefined && !isStringList(selector.flag) ? [`${at}: "flag" must be a list of flag ids`] : []),
    ...(selector.category !== undefined &&
    !(Array.isArray(selector.category) && selector.category.every((c) => isOneOf(FLAG_CATEGORY_ORDER, c)))
      ? [`${at}: "category" must be a list of categories`]
      : []),
    ...(selector.severity !== undefined &&
    !(Array.isArray(selector.severity) && selector.severity.every((s) => isOneOf(SEVERITIES, s)))
      ? [`${at}: "severity" must be a list of info, warning, blocker`]
      : []),
    ...(selector.remedy !== undefined &&
    !(Array.isArray(selector.remedy) && selector.remedy.every((r) => isOneOf(REMEDIES, r)))
      ? [`${at}: "remedy" must be a list of lossless, transcode, manual, none`]
      : []),
    ...(selector.repair !== undefined &&
    !(Array.isArray(selector.repair) && selector.repair.every((r) => r === null || isString(r)))
      ? [`${at}: "repair" must be a list of repair ids or null`]
      : []),
    ...(selector.unresolved !== undefined && typeof selector.unresolved !== 'boolean'
      ? [`${at}: "unresolved" must be true or false`]
      : [])
  ]
}

const selectorListProblems = (list: unknown, at: string): string[] =>
  Array.isArray(list)
    ? list.flatMap((selector, index) => selectorProblems(selector, `${at}[${index}]`))
    : [`${at}: must be a list of selectors`]

/** Problems with one match expression; empty when it is fine. */
export function matchProblems(match: unknown, at: string): string[] {
  if (!isRecord(match)) return [`${at}: a condition must be an object`]
  const keys = Object.keys(match)
  if (keys.length !== 1) return [`${at}: a condition has exactly one of any, all, none, strategy, always, and, or, not`]
  const [key] = keys
  const value = match[key as string]
  switch (key) {
    case 'any':
    case 'all':
    case 'none':
      return selectorListProblems(value, `${at}.${key}`)
    case 'strategy':
      return Array.isArray(value) && value.every((s) => isOneOf(STRATEGIES, s))
        ? []
        : [`${at}.strategy: must be a list of ${STRATEGIES.join(', ')}`]
    case 'always':
      return value === true ? [] : [`${at}.always: must be true`]
    case 'and':
    case 'or':
      return Array.isArray(value)
        ? value.flatMap((inner, index) => matchProblems(inner, `${at}.${key}[${index}]`))
        : [`${at}.${key}: must be a list of conditions`]
    case 'not':
      return matchProblems(value, `${at}.not`)
    default:
      return [`${at}: unknown condition "${key}"`]
  }
}

function statusProblems(status: unknown, at: string): string[] {
  if (!isRecord(status)) return [`${at}: a status must be an object`]
  return [
    ...(['id', 'label', 'badge', 'hint'] as const)
      .filter((field) => !isString(status[field]))
      .map((field) => `${at}: "${field}" must be text`),
    ...(isOneOf(TONES, status.tone) ? [] : [`${at}: "tone" must be one of ${TONES.join(', ')}`]),
    ...(typeof status.passing === 'boolean' ? [] : [`${at}: "passing" must be true or false`])
  ]
}

function ruleProblems(rule: unknown, at: string, statusIds: ReadonlySet<string>): string[] {
  if (!isRecord(rule)) return [`${at}: a status rule must be an object`]
  return [
    ...(isString(rule.status) && statusIds.has(rule.status) ? [] : [`${at}: "status" must name a status`]),
    ...matchProblems(rule.when, `${at}.when`)
  ]
}

/* ------------------------------------------------------------------ *
 * Merging one section
 * ------------------------------------------------------------------ */

/**
 * Field-by-field merge of a patch section over its defaults.
 *
 * An entry for an id the defaults do not have is dropped — the module it
 * configured is gone — and so is any field whose value fails `valid`.
 */
function mergeSection<T extends object>(
  section: string,
  defaults: Readonly<Record<string, T>>,
  patch: unknown,
  validFor: (id: string) => { readonly [K in keyof T]: (value: unknown) => boolean }
): { entries: Record<string, T>; problems: string[] } {
  const patchRecord = isRecord(patch) ? patch : {}
  const unknownIds = Object.keys(patchRecord)
    .filter((id) => !(id in defaults))
    .map((id) => `${section}.${id}: no such entry; ignored`)

  const merged = Object.entries(defaults).map(([id, base]) => {
    const change = patchRecord[id]
    if (change === undefined) return { id, entry: base, problems: [] as string[] }
    if (!isRecord(change)) return { id, entry: base, problems: [`${section}.${id}: must be an object; ignored`] }
    const valid = validFor(id)
    const fields = Object.entries(change)
    const problems = fields
      .filter(([field, value]) => !(field in valid) || !valid[field as keyof T](value))
      .map(([field]) => `${section}.${id}.${field}: not a valid value; ignored`)
    const accepted = Object.fromEntries(
      fields.filter(([field, value]) => field in valid && valid[field as keyof T](value))
    )
    return { id, entry: { ...base, ...accepted } as T, problems }
  })

  return {
    entries: Object.fromEntries(merged.map(({ id, entry }) => [id, entry])),
    problems: [...unknownIds, ...merged.flatMap(({ problems }) => problems)]
  }
}

const CHECK_FIELDS: { readonly [K in keyof CheckEntry]: (value: unknown) => boolean } = {
  enabled: (value) => typeof value === 'boolean',
  params: isParams
}

const REPAIR_FIELDS: { readonly [K in keyof RepairEntry]: (value: unknown) => boolean } = {
  enabled: (value) => typeof value === 'boolean',
  params: isParams,
  recheck: (value) => typeof value === 'boolean'
}

/**
 * What a flag's fields may hold.
 *
 * `repair` is the one with a rule of its own: a built-in repair acts on what
 * its own check concluded rather than on the flag, so a flag can be answered
 * by the repair it shipped with, by nothing at all, or by a repair script —
 * which is handed the flags it answers and does not depend on any check.
 */
const flagFields = (shipped: string | null): { readonly [K in keyof FlagDef]: (value: unknown) => boolean } => ({
  label: isString,
  hint: isString,
  category: (value) => isOneOf<FlagCategory>(FLAG_CATEGORY_ORDER, value),
  keep: (value) => typeof value === 'boolean',
  chip: (value) => typeof value === 'boolean',
  severity: (value) => value === null || isOneOf(SEVERITIES, value),
  repair: (value) => value === null || value === shipped || isScriptRepairId(value as string)
})

/** What a script repair is set to before the user changes anything about it. */
const SCRIPT_REPAIR_DEFAULTS: RepairEntry = { enabled: true, params: {}, recheck: true }

/**
 * The repair entries the patch refers to that are scripts.
 *
 * Scripts are not in `default.json` — they are the user's — so an entry for
 * one exists as soon as the patch mentions it, whether to bind a flag to it or
 * to tune it.
 */
function scriptRepairs(patch: CatalogPatch): Record<string, RepairEntry> {
  const named = [
    ...Object.keys(isRecord(patch.repairs) ? patch.repairs : {}),
    ...Object.values(isRecord(patch.flags) ? patch.flags : {}).map((flag) =>
      isRecord(flag) ? (flag.repair as unknown) : undefined
    )
  ].filter((repair): repair is string => isString(repair) && isScriptRepairId(repair))
  return Object.fromEntries(named.map((repair) => [repair, SCRIPT_REPAIR_DEFAULTS]))
}

/** Statuses and their rules travel together: rules name statuses. */
function resolveStatuses(
  base: Pick<Catalog, 'statuses' | 'statusRules'>,
  patch: CatalogPatch
): { statuses: readonly StatusDef[]; statusRules: readonly StatusRule[]; problems: string[] } {
  const statuses = patch.statuses ?? base.statuses
  const statusRules = patch.statusRules ?? base.statusRules
  const statusList = Array.isArray(statuses) ? statuses : []
  const ids = new Set(statusList.map((status) => (isRecord(status) ? status.id : undefined)).filter(isString))
  const rules = Array.isArray(statusRules) ? statusRules : []
  const problems = [
    ...(Array.isArray(statuses) ? [] : ['statuses: must be a list']),
    ...(Array.isArray(statusRules) ? [] : ['statusRules: must be a list']),
    ...statusList.flatMap((status, index) => statusProblems(status, `statuses[${index}]`)),
    ...(ids.size === statusList.length ? [] : ['statuses: every status needs its own id']),
    ...rules.flatMap((rule, index) => ruleProblems(rule, `statusRules[${index}]`, ids)),
    ...(rules.length > 0 ? [] : ['statusRules: at least one rule is needed'])
  ]
  // A broken status list cannot be half-used: the tiles and the rules have to
  // agree, so on any problem both fall back to what shipped.
  return problems.length === 0
    ? { statuses, statusRules, problems }
    : { statuses: base.statuses, statusRules: base.statusRules, problems }
}

/* ------------------------------------------------------------------ *
 * The whole catalog
 * ------------------------------------------------------------------ */

/**
 * Checks a raw catalog — `default.json`, as read — section by section.
 * Entries that fail are reported; the catalog returned has only valid ones.
 */
export function parseCatalog(raw: unknown): CatalogResult {
  const record = isRecord(raw) ? raw : {}
  const versionProblems = record.version === 1 ? [] : ['version: must be 1']
  const sectionOf = (key: string): Record<string, unknown> => (isRecord(record[key]) ? record[key] : {})

  const entriesOf = <T>(key: string, valid: (value: unknown) => value is T): [Record<string, T>, string[]] => {
    const section = sectionOf(key)
    const good = Object.entries(section).filter((entry): entry is [string, T] => valid(entry[1]))
    const bad = Object.keys(section).filter((id) => !valid(section[id]))
    return [Object.fromEntries(good), bad.map((id) => `${key}.${id}: not a valid entry`)]
  }

  const [checks, checkProblems] = entriesOf(
    'checks',
    (value): value is CheckEntry => isRecord(value) && CHECK_FIELDS.enabled(value.enabled) && CHECK_FIELDS.params(value.params)
  )
  const [repairs, repairProblems] = entriesOf(
    'repairs',
    (value): value is RepairEntry =>
      isRecord(value) &&
      REPAIR_FIELDS.enabled(value.enabled) &&
      REPAIR_FIELDS.params(value.params) &&
      REPAIR_FIELDS.recheck(value.recheck)
  )
  // Here the defaults are being read, so whatever repair an entry names is the
  // one it ships with — as long as that repair exists.
  const [flags, flagProblems] = entriesOf('flags', (value): value is FlagDef => {
    if (!isRecord(value)) return false
    const shipped = isString(value.repair) && value.repair in repairs ? value.repair : null
    const fields = flagFields(shipped)
    return (Object.keys(fields) as (keyof FlagDef)[]).every((field) => fields[field](value[field]))
  })

  const empty: Pick<Catalog, 'statuses' | 'statusRules'> = { statuses: [], statusRules: [] }
  const status = resolveStatuses(empty, {
    statuses: record.statuses as StatusDef[],
    statusRules: record.statusRules as StatusRule[]
  })

  return {
    catalog: { version: 1, checks, repairs, flags, statuses: status.statuses, statusRules: status.statusRules },
    problems: [...versionProblems, ...checkProblems, ...repairProblems, ...flagProblems, ...status.problems]
  }
}

/** The shipped catalog, checked once. Its problems are a test failure, never a user's. */
export const DEFAULT_CATALOG_RESULT: CatalogResult = parseCatalog(defaultJson)
export const DEFAULT_CATALOG: Catalog = DEFAULT_CATALOG_RESULT.catalog

/** The defaults with the user's patch laid over them. */
export function resolveCatalog(defaults: Catalog, patch: CatalogPatch | undefined): CatalogResult {
  const given: CatalogPatch = isRecord(patch) ? patch : {}
  // A check script is in the catalog once it has been approved and switched
  // on, which writes its entry; until then it does not run.
  const checkScripts = Object.fromEntries(
    Object.keys(isRecord(given.checks) ? given.checks : {})
      .filter(isCheckScriptId)
      .map((id) => [id, { enabled: false, params: {} } satisfies CheckEntry])
  )
  const checks = mergeSection('checks', { ...defaults.checks, ...checkScripts }, given.checks, () => CHECK_FIELDS)
  const repairs = mergeSection(
    'repairs',
    { ...defaults.repairs, ...scriptRepairs(given) },
    given.repairs,
    () => REPAIR_FIELDS
  )
  // A rule's flag exists in the catalog once the patch says anything about it.
  // So are a check script's flags, which approving it writes from its manifest.
  const ruleFlags = Object.fromEntries(
    Object.keys(isRecord(given.flags) ? given.flags : {})
      .filter((code) => isRuleCode(code) || isCheckScriptFlag(code))
      .map((code) => [code, ruleFlagDefaults(code)])
  )
  const flags = mergeSection('flags', { ...defaults.flags, ...ruleFlags }, given.flags, (id) =>
    flagFields(defaults.flags[id]?.repair ?? null)
  )
  const status = resolveStatuses(defaults, given)
  return {
    catalog: {
      version: 1,
      checks: checks.entries,
      repairs: repairs.entries,
      flags: flags.entries,
      statuses: status.statuses,
      statusRules: status.statusRules
    },
    problems: [...checks.problems, ...repairs.problems, ...flags.problems, ...status.problems]
  }
}

/**
 * The catalog for a set of settings.
 *
 * Remembered per patch object: analysis asks for it once per file, and the
 * patch only changes when the user edits something.
 */
const resolvedByPatch = new WeakMap<object, CatalogResult>()
const EMPTY_PATCH: CatalogPatch = {}

export function catalogResultFor(settings: Partial<Pick<AppSettings, 'catalog'>> | undefined): CatalogResult {
  const patch = settings?.catalog ?? EMPTY_PATCH
  const known = resolvedByPatch.get(patch)
  if (known) return known
  const result = resolveCatalog(DEFAULT_CATALOG, patch)
  resolvedByPatch.set(patch, result)
  return result
}

export const catalogFor = (settings: Partial<Pick<AppSettings, 'catalog'>> | undefined): Catalog =>
  catalogResultFor(settings).catalog

/** A module's shipped parameter values. */
export const shippedParams = (section: 'checks' | 'repairs', id: string): Readonly<Record<string, ParamValue>> =>
  DEFAULT_CATALOG[section][id]?.params ?? {}

/** The repair a flag shipped with, which is what the built-in checks assume will answer it. */
export const shippedRepairOf = (flag: string): string | null => DEFAULT_CATALOG.flags[flag]?.repair ?? null

/** Whether a code is one of the user's own rules: those are flags too, named after the rule. */
export const isRuleCode = (code: string): boolean => code.startsWith('user.')

/** How a rule's flag is set until the user changes it. */
const ruleFlagDefaults = (code: string): FlagDef => ({
  label: `Rule: ${code.slice('user.'.length).replace(/-/g, ' ')}`,
  hint: 'Something a rule you wrote reported.',
  category: 'custom',
  keep: true,
  chip: true,
  severity: null,
  repair: null
})

/** The flag's definition, or a plain one for a code the catalog does not list. */
export function flagDef(catalog: Catalog, flag: string): FlagDef {
  return catalog.flags[flag] ?? (isRuleCode(flag) ? ruleFlagDefaults(flag) : { ...ruleFlagDefaults(flag), label: flag, hint: '' })
}

/** Exposed for the status editor, which checks a rule before saving it. */
export type { FlagSelector, StatusMatch }
