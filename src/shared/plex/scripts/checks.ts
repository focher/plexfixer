/**
 * Check scripts: the user's own checks, run when a file is read.
 *
 * A built-in check is a function of the probe and costs nothing to run again,
 * so it is re-run whenever settings change. A script is a process that may
 * read the whole file, so it runs once, when the file is scanned, and what it
 * found is kept on the file (`MediaFile.checkReports`). Analysis reads that
 * answer back like any other fact about the file. The answer is stale — and
 * the script due to run again — when the file, the script, or the script's
 * settings have changed since; the fingerprint is how that is told.
 */

import type { RepairHost } from '../../host.js'
import type { AppSettings, CheckReport, Finding, MediaFile, RemedyClass, Severity } from '../../types.js'
import { catalogFor } from '../catalog/resolve.js'
import { resolveParams, type ParamValues } from '../modules/params.js'
import { checkScriptFlag, checkScriptId, type ScriptInfo, type ScriptManifest } from './manifest.js'
import { buildCheckInput } from './protocol.js'
import { runScript } from './run.js'

/** A check script that is due to run: approved, switched on, and its settings worked out. */
export interface ActiveCheck {
  id: string
  manifest: ScriptManifest
  params: ParamValues
  /** The script's files and settings, as one string; a report with another is stale. */
  fingerprint: string
}

/**
 * The check scripts that run on a scan.
 *
 * Only approved ones that the catalog has switched on. A check script is
 * switched on in the catalog when it is approved, and that entry is also
 * where its settings are kept.
 */
export function activeChecks(scripts: readonly ScriptInfo[], settings: Pick<AppSettings, 'catalog'>): ActiveCheck[] {
  const catalog = catalogFor(settings)
  return scripts
    .filter((script) => script.kind === 'checks' && script.trust === 'approved' && script.manifest)
    .filter((script) => catalog.checks[checkScriptId(script.id)]?.enabled === true)
    .map((script) => {
      const manifest = script.manifest as ScriptManifest
      const params = resolveParams(manifest.params, manifest.defaults, catalog.checks[checkScriptId(script.id)]?.params)
      return { id: script.id, manifest, params, fingerprint: `${script.hash ?? ''}:${JSON.stringify(params)}` }
    })
}

/** Whether every active check has an answer about this file that is still current. */
export const reportsCurrent = (
  reports: Readonly<Record<string, { fingerprint: string }>> | undefined,
  active: readonly ActiveCheck[]
): boolean => active.every((check) => reports?.[check.id]?.fingerprint === check.fingerprint)

const SEVERITIES: readonly Severity[] = ['info', 'warning', 'blocker']
const REMEDIES: readonly RemedyClass[] = ['lossless', 'transcode', 'manual', 'none']

/**
 * What a check script reported, as findings.
 *
 * Only codes the manifest lists are taken — a script cannot raise a flag the
 * user was not shown when approving it, nor pass itself off as a built-in
 * check — and each is scoped by the script: `adverts` from `subtitle-ads`
 * becomes `ext.subtitle-ads.adverts`.
 */
export function findingsFrom(manifest: ScriptManifest, raw: readonly unknown[]): { findings: Finding[]; problems: string[] } {
  const read = raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return { problems: [`finding ${index + 1} is not an object`] }
    const record = entry as Record<string, unknown>
    const flag = manifest.raises.find((candidate) => candidate.code === record.code)
    if (!flag) return { problems: [`finding ${index + 1}: "${String(record.code)}" is not one of the codes plugin.json lists`] }
    const streamIndexes = Array.isArray(record.streamIndexes)
      ? record.streamIndexes.filter((value): value is number => Number.isInteger(value))
      : []
    const finding: Finding = {
      code: checkScriptFlag(manifest.id, flag.code),
      severity: SEVERITIES.includes(record.severity as Severity) ? (record.severity as Severity) : flag.severity,
      remedy: REMEDIES.includes(record.remedy as RemedyClass) ? (record.remedy as RemedyClass) : 'manual',
      title: typeof record.title === 'string' && record.title.trim() ? record.title : flag.label,
      detail: typeof record.detail === 'string' ? record.detail : flag.hint,
      ...(streamIndexes.length > 0 ? { streamIndexes } : {})
    }
    return { finding, problems: [] }
  })
  return {
    findings: read.flatMap((entry) => ('finding' in entry && entry.finding ? [entry.finding] : [])),
    problems: read.flatMap((entry) => entry.problems)
  }
}

/** The most findings one script may report about one file; past this it is not checking, it is flooding. */
const MOST_FINDINGS = 50

/**
 * Run every active check on one file, one after another.
 *
 * A check that fails — will not start, times out, says nothing sensible —
 * gives an answer that says so, rather than failing the scan: one broken
 * script should not cost the user the rest of their library.
 */
export async function runChecks(args: {
  file: MediaFile
  active: readonly ActiveCheck[]
  host: Pick<RepairHost, 'startScript' | 'label' | 'exists'>
  ffmpegPath: string
  ffprobePath: string
  settings: Pick<AppSettings, 'preferredSubtitleLanguage'>
  signal: AbortSignal
}): Promise<Record<string, CheckReport>> {
  const reports: [string, CheckReport][] = []
  for (const check of args.active) {
    if (args.signal.aborted) break
    try {
      const { findings: raw = [] } = await runScript({
        host: args.host,
        kind: 'checks',
        script: check.id,
        signal: args.signal,
        timeoutSeconds: check.manifest.timeoutSeconds ?? 60,
        onEvent: () => undefined,
        input: buildCheckInput({
          id: check.id,
          version: check.manifest.version,
          params: check.params,
          file: args.file,
          ffmpegPath: args.ffmpegPath,
          ffprobePath: args.ffprobePath,
          settings: args.settings
        })
      })
      const { findings, problems } = findingsFrom(check.manifest, raw.slice(0, MOST_FINDINGS))
      reports.push([
        check.id,
        { fingerprint: check.fingerprint, findings, ...(problems.length > 0 ? { error: problems.join('; ') } : {}) }
      ])
    } catch (error) {
      reports.push([
        check.id,
        { fingerprint: check.fingerprint, findings: [], error: error instanceof Error ? error.message : String(error) }
      ])
    }
  }
  return Object.fromEntries(reports)
}

/** The file with fresh answers from every active check, keeping answers from checks not run now. */
export async function withCheckReports(
  file: MediaFile,
  run: Omit<Parameters<typeof runChecks>[0], 'file'>
): Promise<MediaFile> {
  if (run.active.length === 0) return file
  const fresh = await runChecks({ ...run, file })
  return { ...file, checkReports: { ...file.checkReports, ...fresh } }
}

export { checkScriptId }
