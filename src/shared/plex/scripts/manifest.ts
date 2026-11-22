/**
 * Repair scripts: what a script's `plugin.json` says, and what the app makes
 * of the folder it found it in.
 *
 * A script is a repair the user adds: a folder under the app's `repairs/`
 * directory holding a `plugin.json` and whatever the script needs, in any
 * language. The app hands it a file and gets a file back. Which flags it
 * answers is not up to the script — the user binds flags to it under Checks &
 * repairs, the same way a built-in repair's flags can be made report-only.
 *
 * The native side hashes the folder and refuses to start anything the user
 * has not approved as it is now. Everything about reading the manifest lives
 * here, next to its tests.
 */

import type { FindingCode, Severity } from '../../types.js'
import { FLAG_CATEGORY_ORDER, type FlagCategory, type ParamValue } from '../catalog/types.js'
import { validateParam, type ParamSchema, type ParamSpec } from '../modules/params.js'

export const SCRIPT_PROTOCOL = 1

/** A script's repair id, as flags and the catalog name it. */
export const scriptRepairId = (id: string): string => `script.${id}`

export const isScriptRepairId = (repair: string | null | undefined): repair is string =>
  typeof repair === 'string' && /^script\.[a-z0-9][a-z0-9-]{0,63}$/.test(repair)

export const scriptIdOf = (repair: string): string => repair.slice('script.'.length)

/** Which folder a script lives in, and so what it is for. */
export type ScriptKind = 'checks' | 'repairs'

/** A check script's module id in the catalog. */
export const checkScriptId = (id: string): string => `ext.${id}`

/** One of a check script's flags: its own code, scoped by the script so two scripts cannot collide. */
export const checkScriptFlag = (id: string, code: string): FindingCode => `ext.${id}.${code}`

export const isCheckScriptId = (id: string): boolean => /^ext\.[a-z0-9][a-z0-9-]{0,63}$/.test(id)

export const isCheckScriptFlag = (code: string): boolean => /^ext\.[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/.test(code)

/** A flag a check script can raise, as its manifest describes it. */
export interface ScriptFlag {
  /** The script's own name for it; the flag id is `ext.<script>.<code>`. */
  code: string
  label: string
  hint: string
  category: FlagCategory
  /** What the finding is unless the script says otherwise for a particular file. */
  severity: Severity
}

export interface ScriptManifest {
  protocol: 1
  id: string
  name: string
  version: string
  summary: string
  whatItDoes: string
  howItWorks: string
  ifDisabled: string
  /** The program and its arguments; `{pluginDir}` is the script's folder. */
  command: readonly string[]
  /** What the script can be tuned by. */
  params: ParamSchema
  /** What each parameter is set to until the user changes it. */
  defaults: Readonly<Record<string, ParamValue>>
  /** Flags the script is written for; offered first when binding, never bound on their own. */
  suggestedFlags: readonly string[]
  /** How long one run may take before it is stopped; none when absent. */
  timeoutSeconds?: number
  /** For a check script: the flags it can raise. Empty for a repair script. */
  raises: readonly ScriptFlag[]
}

/** One folder under `repairs/`, as the native side found it. */
export interface ScriptListing {
  kind?: ScriptKind
  id: string
  dir: string
  manifest?: string
  hash?: string
  trustedHash?: string
  files: { path: string; size: number }[]
  problem?: string
}

export type ScriptTrust = 'approved' | 'unapproved' | 'changed' | 'broken'

/** A script as the app understands it. */
export interface ScriptInfo {
  kind: ScriptKind
  id: string
  /** `script.<id>` for a repair, `ext.<id>` for a check: its id in the catalog. */
  repairId: string
  dir: string
  manifest?: ScriptManifest
  problems: string[]
  trust: ScriptTrust
  hash?: string
  files: { path: string; size: number }[]
}

/* ------------------------------------------------------------------ *
 * Reading plugin.json
 * ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (record: Record<string, unknown>, key: string, fallback = ''): string =>
  typeof record[key] === 'string' ? (record[key] as string) : fallback

const PARAM_TYPES = ['number', 'boolean', 'string', 'list'] as const

/** One parameter: its spec, and the default the manifest gives it. */
function readParam(
  key: string,
  raw: unknown
): { spec?: ParamSpec; value?: ParamValue; problems: string[] } {
  if (!isRecord(raw)) return { problems: [`params.${key}: must be an object`] }
  const type = raw.type
  if (!PARAM_TYPES.includes(type as (typeof PARAM_TYPES)[number])) {
    return { problems: [`params.${key}: "type" must be number, boolean, string or list`] }
  }
  const options = Array.isArray(raw.options)
    ? raw.options.filter(isRecord).map((option) => ({ value: option.value, label: String(option.label ?? option.value) }))
    : undefined
  const spec = {
    type,
    label: text(raw, 'label', key),
    ...(typeof raw.help === 'string' ? { help: raw.help } : {}),
    ...(typeof raw.min === 'number' ? { min: raw.min } : {}),
    ...(typeof raw.max === 'number' ? { max: raw.max } : {}),
    ...(typeof raw.step === 'number' ? { step: raw.step } : {}),
    ...(options ? { options } : {})
  } as ParamSpec
  return validateParam(spec, raw.default)
    ? { spec, value: raw.default, problems: [] }
    : { problems: [`params.${key}: needs a "default" that fits its type`] }
}

const SEVERITIES: readonly Severity[] = ['info', 'warning', 'blocker']
const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The flags a check script declares. */
function readRaises(raw: unknown): { flags: ScriptFlag[]; problems: string[] } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { flags: [], problems: ['"raises" must list the flags the check can report, at least one'] }
  }
  const read = raw.map((entry, index) => {
    if (!isRecord(entry)) return { problems: [`raises[${index}]: must be an object`] }
    const code = entry.code
    if (typeof code !== 'string' || !CODE.test(code)) {
      return { problems: [`raises[${index}]: "code" must be lower-case letters, digits and dashes`] }
    }
    const category = FLAG_CATEGORY_ORDER.includes(entry.category as FlagCategory) ? (entry.category as FlagCategory) : 'custom'
    const severity = SEVERITIES.includes(entry.severity as Severity) ? (entry.severity as Severity) : 'warning'
    return {
      flag: { code, label: text(entry, 'label', code), hint: text(entry, 'hint'), category, severity },
      problems: []
    }
  })
  const flags = read.flatMap((entry) => ('flag' in entry && entry.flag ? [entry.flag] : []))
  const duplicate = flags.find((flag, index) => flags.findIndex((other) => other.code === flag.code) !== index)
  return {
    flags,
    problems: [
      ...read.flatMap((entry) => entry.problems),
      ...(duplicate ? [`raises: "${duplicate.code}" is listed twice`] : [])
    ]
  }
}

/** Reads a `plugin.json`, checking it belongs in the folder it was found in. */
export function parseManifest(
  source: string,
  folder: string,
  kind: ScriptKind = 'repairs'
): { manifest?: ScriptManifest; problems: string[] } {
  const parsed = ((): { value?: unknown; error?: string } => {
    try {
      return { value: JSON.parse(source) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })()
  if (parsed.error) return { problems: [`plugin.json is not JSON: ${parsed.error}`] }
  const raw = parsed.value
  if (!isRecord(raw)) return { problems: ['plugin.json must be a JSON object'] }

  const params = Object.entries(isRecord(raw.params) ? raw.params : {}).map(([key, value]) => ({
    key,
    ...readParam(key, value)
  }))
  const command = Array.isArray(raw.command) ? raw.command : []
  const raises = kind === 'checks' ? readRaises(raw.raises) : { flags: [], problems: [] }

  const problems = [
    ...(raw.protocol === SCRIPT_PROTOCOL ? [] : [`"protocol" must be ${SCRIPT_PROTOCOL}`]),
    ...(raw.id === folder ? [] : [`"id" must be "${folder}", the name of its folder`]),
    ...(text(raw, 'name').trim() ? [] : ['"name" is needed: it is what the script is called on screen']),
    ...(command.length > 0 && command.every((part) => typeof part === 'string')
      ? []
      : ['"command" must be a list of text: the program, then its arguments']),
    ...(raw.params !== undefined && !isRecord(raw.params) ? ['"params" must be an object'] : []),
    ...params.flatMap((param) => param.problems),
    ...(raw.timeoutSeconds !== undefined && !(typeof raw.timeoutSeconds === 'number' && raw.timeoutSeconds > 0)
      ? ['"timeoutSeconds" must be a positive number']
      : []),
    ...raises.problems
  ]
  if (problems.length > 0) return { problems }

  const good = params.filter((param) => param.spec !== undefined)
  return {
    manifest: {
      protocol: SCRIPT_PROTOCOL,
      id: folder,
      name: text(raw, 'name'),
      version: text(raw, 'version', '0'),
      summary: text(raw, 'summary'),
      whatItDoes: text(raw, 'whatItDoes', text(raw, 'summary')),
      howItWorks: text(raw, 'howItWorks'),
      ifDisabled: text(raw, 'ifDisabled', 'The flags bound to it are reported but not fixed.'),
      command: command as string[],
      params: Object.fromEntries(good.map((param) => [param.key, param.spec as ParamSpec])),
      defaults: Object.fromEntries(good.map((param) => [param.key, param.value as ParamValue])),
      suggestedFlags: Array.isArray(raw.suggestedFlags)
        ? raw.suggestedFlags.filter((flag): flag is string => typeof flag === 'string')
        : [],
      ...(typeof raw.timeoutSeconds === 'number' ? { timeoutSeconds: raw.timeoutSeconds } : {}),
      raises: raises.flags
    },
    problems: []
  }
}

/** What a listing amounts to: its manifest, its problems, and whether it may run. */
export function scriptInfo(listing: ScriptListing, kind: ScriptKind = listing.kind ?? 'repairs'): ScriptInfo {
  const read = listing.manifest !== undefined ? parseManifest(listing.manifest, listing.id, kind) : { problems: [] }
  const problems = [...(listing.problem ? [listing.problem] : []), ...read.problems]
  const trust: ScriptTrust =
    problems.length > 0 || !read.manifest
      ? 'broken'
      : listing.trustedHash === undefined
        ? 'unapproved'
        : listing.trustedHash === listing.hash
          ? 'approved'
          : 'changed'
  return {
    kind,
    id: listing.id,
    repairId: kind === 'checks' ? checkScriptId(listing.id) : scriptRepairId(listing.id),
    dir: listing.dir,
    ...(read.manifest ? { manifest: read.manifest } : {}),
    problems: problems.length > 0 || read.manifest ? problems : ['there is no plugin.json in the folder'],
    trust,
    ...(listing.hash ? { hash: listing.hash } : {}),
    files: listing.files
  }
}
