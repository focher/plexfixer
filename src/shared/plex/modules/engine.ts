/**
 * Running the modules: checks first, then repairs, then the plan.
 *
 * The shape of a run is deliberately boring, because the interesting decisions
 * all live in the modules themselves:
 *
 * 1. Pull the file apart into video, audio and subtitle tracks, and work out
 *    what language the thing is in.
 * 2. Run each enabled check in registry order, collecting findings and letting
 *    each one add to what is known so far.
 * 3. Run each enabled repair over that, collecting the steps it wants taken.
 * 4. Assemble the result: one plan, one verdict, one list of what the plan does
 *    not fix.
 *
 * Step 4 is the only place that knows about the plan as a whole — how the
 * separate fixes add up to a strategy, and what a run is going to cost. A
 * module knows its own job and nothing else, which is the point.
 */

import type {
  AnalysisResult,
  AppSettings,
  FileVerdict,
  Finding,
  FindingCode,
  MediaFile,
  PlanAction,
  PlanStrategy,
  RepairPlan,
  ScriptStep,
  TrackPlanChange
} from '../../types.js'
import { catalogFor, flagDef, shippedRepairOf } from '../catalog/resolve.js'
import type { Catalog } from '../catalog/types.js'
import { preferredHevcTag } from '../rules.js'
import { audioStreams, resolvePrimaryLanguage, subtitleStreams, videoStreams } from '../tracks.js'
import { CHECK_MODULES, REPAIR_MODULES } from './registry.js'
import { userCheckModules } from './script/module.js'
import { paramsFor } from './module-params.js'
import { isRuleCode } from '../catalog/resolve.js'
import { isScriptRepairId, scriptIdOf } from '../scripts/manifest.js'
import {
  initialState,
  isModuleEnabled,
  mergeSignals,
  strongerStrategy,
  type CheckContext,
  type MediaContext,
  type RepairModule,
  type RepairContext,
  type ScanState
} from './framework.js'

/** What a run produced, before it is turned into an `AnalysisResult`. */
export interface ModuleRun {
  findings: Finding[]
  state: ScanState
  plan: RepairPlan
}

function mediaContext(file: MediaFile, settings: AppSettings): MediaContext {
  return {
    file,
    settings,
    video: videoStreams(file),
    audio: audioStreams(file),
    subtitles: subtitleStreams(file),
    primary: resolvePrimaryLanguage(file, settings)
  }
}

/** Whether a module runs: on in the catalog, and not switched off the older way. */
const runs = (id: string, settings: AppSettings, entry: { enabled: boolean } | undefined): boolean =>
  isModuleEnabled(id, settings) && entry?.enabled !== false

/**
 * The catalog's say over one finding: dropped when its flag is not kept, and
 * given the catalog's severity when one is set.
 */
const throughCatalog = (findings: readonly Finding[], catalog: Catalog): Finding[] =>
  findings
    .filter((finding) => flagDef(catalog, finding.code).keep)
    .map((finding) => {
      const severity = flagDef(catalog, finding.code).severity
      return severity && severity !== finding.severity ? { ...finding, severity } : finding
    })

/**
 * Whether the built-in repairs should act on a flag.
 *
 * A check's signals are what the built-in repairs act on, and they assume the
 * flag is answered the way it shipped. A flag the user discarded, or took away
 * from its built-in repair, must not be quietly fixed anyway.
 */
const answeredAsShipped = (code: FindingCode, catalog: Catalog): boolean => {
  const def = flagDef(catalog, code)
  return def.keep && def.repair === shippedRepairOf(code)
}

/**
 * Every check, in order, each handed what the ones before it concluded.
 *
 * Rules the user wrote run last, after everything that ships with the app. By
 * then the container is settled and the track metadata is worked out, so a
 * hand-written rule is reading a finished picture of the file rather than a
 * half-made one — and a rule that will not parse is left out rather than
 * stopping the scan.
 */
function runChecks(
  media: MediaContext,
  catalog: Catalog
): { findings: Finding[]; raised: Set<FindingCode>; state: ScanState } {
  let state = initialState(media.settings)
  const findings: Finding[] = []
  // Every code a check raised, kept or not, so the repairs can tell a flag
  // the user set aside from one that never came up.
  const raisedCodes = new Set<FindingCode>()

  for (const module of [...CHECK_MODULES, ...userCheckModules(media.settings)]) {
    if (!runs(module.id, media.settings, catalog.checks[module.id])) continue
    const context: CheckContext = { ...media, state, params: paramsFor(module, 'checks', media.settings) }
    const result = module.run(context)
    const raised = result.findings ?? []
    for (const finding of raised) raisedCodes.add(finding.code)
    findings.push(...throughCatalog(raised, catalog))
    // A check that raised nothing is still deciding things (the container, the
    // default track) that later checks build on, so its signals always count.
    // One that raised flags counts only while some of them are answered as shipped.
    const signalsCount = raised.length === 0 || raised.some((finding) => answeredAsShipped(finding.code, catalog))
    if (signalsCount) state = mergeSignals(state, result.signals)
  }

  return { findings, raised: raisedCodes, state }
}

/** The codes a repair answers on this file, counting the user's rules for one that takes them. */
const answersOf = (module: RepairModule, raised: ReadonlySet<FindingCode>): readonly FindingCode[] =>
  module.answersRules ? [...module.answers, ...[...raised].filter(isRuleCode)] : module.answers

/**
 * Whether the user has taken all of a repair's work away from it.
 *
 * True when the file raised flags this repair answers and not one of them is
 * still answered by it as shipped. A repair whose flags never came up runs as
 * it always did: several work from what the file is rather than from a flag,
 * and their flags are how the user steers them, not what starts them.
 */
const setAside = (answers: readonly FindingCode[], raised: ReadonlySet<FindingCode>, catalog: Catalog): boolean => {
  const present = answers.filter((code) => raised.has(code))
  return present.length > 0 && !present.some((code) => answeredAsShipped(code, catalog))
}

export function analyzeWithModules(file: MediaFile, settings: AppSettings): AnalysisResult {
  const media = mediaContext(file, settings)
  const catalog = catalogFor(settings)
  const { findings: rawFindings, raised, state } = runChecks(media, catalog)

  /* --- repairs ------------------------------------------------------- */

  let findings = rawFindings
  // The changes the checks worked out, which the repairs may add to, withdraw
  // from, or decide they cannot carry out after all.
  let trackChanges: TrackPlanChange[] = [...state.trackChanges]
  const actions: PlanAction[] = []
  const remuxParts: string[] = []
  let strategy: PlanStrategy = 'none'
  const plan: RepairPlan = {
    strategy: 'none',
    targetContainer: state.targetContainer,
    actions,
    trackChanges: [],
    extractSubtitles: [],
    faststart: state.targetContainer === 'mp4',
    unresolved: [],
    requiresTranscode: false,
    costNote: ''
  }

  /**
   * Codes whose repair the user has switched off, or taken away from the
   * flag: reported, but not fixed.
   */
  const scriptSteps = scriptStepsFor(rawFindings, catalog)
  const scripted = new Set(scriptSteps.flatMap((step) => step.flags))
  const unrepaired = new Set<FindingCode>(
    rawFindings
      .map((finding) => finding.code)
      .filter((code) => !answeredAsShipped(code, catalog) && !scripted.has(code))
  )

  // Where the composed "Remux: …" line belongs: where the first module that
  // wanted a piece of it would have put its own line.
  let remuxActionAt = 0

  const runRepair = (module: (typeof REPAIR_MODULES)[number]): void => {
    const answers = answersOf(module, raised)
    if (!runs(module.id, settings, catalog.repairs[module.id])) {
      for (const code of answers) unrepaired.add(code)
      return
    }
    if (setAside(answers, raised, catalog)) return
    const context: RepairContext = {
      ...media,
      state,
      params: paramsFor(module, 'repairs', settings),
      findings,
      strategy: strongerStrategy(strategy, trackChanges.length > 0 ? 'remux' : 'none')
    }
    const result = module.run(context)

    if (result.actions?.length) actions.push(...result.actions)
    if (result.remuxParts?.length) {
      if (remuxParts.length === 0) remuxActionAt = actions.length
      remuxParts.push(...result.remuxParts)
    }
    // Amendments come before additions: a repair that withdraws the changes
    // another module made must not withdraw its own in the same breath.
    if (result.amendTrackChanges) trackChanges = result.amendTrackChanges(trackChanges)
    if (result.trackChanges?.length) trackChanges.push(...result.trackChanges)
    if (result.strategy) strategy = strongerStrategy(strategy, result.strategy)
    if (result.amendFindings) findings = result.amendFindings(findings)

    const fragment = result.plan
    if (fragment?.videoTranscode) plan.videoTranscode = fragment.videoTranscode
    if (fragment?.addCompatibilityAudio) plan.addCompatibilityAudio = fragment.addCompatibilityAudio
    if (fragment?.extractSubtitles?.length) plan.extractSubtitles.push(...fragment.extractSubtitles)
    if (fragment?.videoLevel !== undefined) plan.videoLevel = fragment.videoLevel
  }

  for (const module of REPAIR_MODULES) {
    if (module.when === 'afterPlan') continue
    runRepair(module)
  }

  /* --- the plan as a whole -------------------------------------------- */

  // A script works on the file ffmpeg writes, so a plan with one is at least a
  // stream copy: the copy is what the script is handed.
  for (const step of scriptSteps) {
    actions.push({
      label: `Run repair script ${step.script}`,
      detail: `Answers ${step.flags.join(', ')}. Runs on the remuxed file, which is then checked like any other output.`
    })
  }
  if (scriptSteps.length > 0) strategy = strongerStrategy(strategy, 'remux')

  // Four separate fixes that are one pass over the file, said as one line.
  if (remuxParts.length > 0) {
    actions.splice(remuxActionAt, 0, {
      label: `Remux: ${remuxParts.join(', ')}`,
      detail: 'Stream copy — the audio and video data are not touched.'
    })
  }

  // Metadata changes are a reason to rewrite the file in their own right, and
  // the only one that can still evaporate at this point: a repair is allowed to
  // withdraw a change it cannot actually make.
  const settled: PlanStrategy =
    trackChanges.length > 0 ? strongerStrategy(strategy, 'remux') : strategy

  // What is left depends on the plan rather than shaping it, so it runs now
  // that the plan has stopped moving.
  for (const module of REPAIR_MODULES) {
    if (module.when === 'afterPlan') runRepair(module)
  }

  // An existing hvc1 tag is preserved and an hev1 tag corrected; a Dolby Vision
  // stream keeps the dvh1 family so the DV signalling survives the remux. When
  // we re-encode, the output is plain HEVC whatever went in, so it takes hvc1.
  const outputVideoCodec = plan.videoTranscode?.codec ?? media.video[0]?.codec.toLowerCase()
  const videoCodecTag =
    state.targetContainer === 'mp4' && (outputVideoCodec === 'hevc' || outputVideoCodec === 'h265')
      ? plan.videoTranscode
        ? 'hvc1'
        : preferredHevcTag(media.video[0]?.codecTag)
      : undefined

  plan.strategy = settled
  plan.trackChanges = trackChanges
  plan.videoCodecTag = videoCodecTag
  plan.requiresTranscode = settled === 'transcode-video'
  plan.costNote = costNoteFor(settled)
  // A flag bound to a script is the script's to fix, whatever remedy the check
  // that raised it thought it had.
  plan.unresolved = unresolvedFindings(findings, settled, unrepaired).filter((finding) => !scripted.has(finding.code))
  if (scriptSteps.length > 0) plan.scriptSteps = scriptSteps

  return {
    file,
    verdict: verdictFor(findings),
    findings,
    plan,
    primaryLanguage: media.primary.language,
    primaryLanguageSource: media.primary.source
  }
}

/**
 * The scripts this file's flags call for: one step per enabled script, in the
 * order its first flag was raised, carrying every flag bound to it.
 */
function scriptStepsFor(findings: readonly Finding[], catalog: Catalog): ScriptStep[] {
  const bound = findings
    .map((finding) => ({ code: finding.code, repair: flagDef(catalog, finding.code).repair }))
    .filter((entry): entry is { code: FindingCode; repair: string } => isScriptRepairId(entry.repair))
    .filter((entry) => catalog.repairs[entry.repair]?.enabled !== false)
  const repairs = [...new Set(bound.map((entry) => entry.repair))]
  return repairs.map((repair) => ({
    script: scriptIdOf(repair),
    params: { ...(catalog.repairs[repair]?.params ?? {}) },
    flags: [...new Set(bound.filter((entry) => entry.repair === repair).map((entry) => entry.code))]
  }))
}

function costNoteFor(strategy: PlanStrategy): string {
  if (strategy === 'transcode-video') {
    return 'Full video re-encode — minutes to hours per file, GPU accelerated where available'
  }
  if (strategy === 'transcode-audio') return 'Stream copy plus one audio encode — roughly as fast as a file copy'
  if (strategy === 'remux') return 'Stream copy — limited by disk speed'
  return 'Nothing to do'
}

/** Findings this run will not fix, and so has to leave on the report. */
function unresolvedFindings(
  findings: readonly Finding[],
  strategy: PlanStrategy,
  unrepaired: ReadonlySet<FindingCode>
): Finding[] {
  // Resolved by the companion AAC track rather than by a video re-encode.
  const audioCodes: FindingCode[] = [
    'audio-codec-unsupported',
    'audio-codec-limited',
    'audio-channels-high',
    'audio-no-compatible-track'
  ]
  return findings.filter((finding) => {
    // The repair that would have answered this is switched off.
    if (unrepaired.has(finding.code)) return true
    if (finding.remedy === 'manual') return true
    if (finding.remedy === 'transcode' && strategy !== 'transcode-video') {
      if (audioCodes.includes(finding.code) && strategy === 'transcode-audio') return false
      return true
    }
    return false
  })
}

function verdictFor(findings: readonly Finding[]): FileVerdict {
  if (findings.some((f) => f.severity === 'blocker')) return 'fail'
  if (findings.some((f) => f.severity === 'warning')) return 'warn'
  return 'ok'
}
