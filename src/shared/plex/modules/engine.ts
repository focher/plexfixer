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
  TrackPlanChange
} from '../../types.js'
import { preferredHevcTag } from '../rules.js'
import type { MetadataEdit } from '../metadata.js'
import { audioStreams, resolvePrimaryLanguage, subtitleStreams, videoStreams } from '../tracks.js'
import { CHECK_MODULES, REPAIR_MODULES } from './registry.js'
import { userCheckModules } from './script/module.js'
import {
  initialState,
  isModuleEnabled,
  mergeSignals,
  strongerStrategy,
  type CheckContext,
  type MediaContext,
  type RepairContext,
  type ScanState
} from './framework.js'

/** What a run produced, before it is turned into an `AnalysisResult`. */
export interface ModuleRun {
  findings: Finding[]
  state: ScanState
  plan: RepairPlan
}

function mediaContext(file: MediaFile, settings: AppSettings, edits?: MetadataEdit): MediaContext {
  return {
    file,
    settings,
    edits,
    video: videoStreams(file),
    audio: audioStreams(file),
    subtitles: subtitleStreams(file),
    primary: resolvePrimaryLanguage(file, settings)
  }
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
function runChecks(media: MediaContext): { findings: Finding[]; state: ScanState } {
  let state = initialState(media.settings)
  const findings: Finding[] = []

  for (const module of [...CHECK_MODULES, ...userCheckModules(media.settings)]) {
    if (!isModuleEnabled(module, media.settings)) continue
    const context: CheckContext = { ...media, state }
    const result = module.run(context)
    if (result.findings?.length) findings.push(...result.findings)
    state = mergeSignals(state, result.signals)
  }

  return { findings, state }
}

export function analyzeWithModules(
  file: MediaFile,
  settings: AppSettings,
  edits?: MetadataEdit
): AnalysisResult {
  const media = mediaContext(file, settings, edits)
  const { findings: rawFindings, state } = runChecks(media)

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
    resyncSubtitles: [],
    faststart: state.targetContainer === 'mp4',
    unresolved: [],
    requiresTranscode: false,
    costNote: ''
  }

  /** Codes whose repair the user has switched off: reported, but not fixed. */
  const unrepaired = new Set<FindingCode>()

  // Where the composed "Remux: …" line belongs: where the first module that
  // wanted a piece of it would have put its own line.
  let remuxActionAt = 0

  const runRepair = (module: (typeof REPAIR_MODULES)[number]): void => {
    if (!isModuleEnabled(module, settings)) {
      for (const code of module.answers) unrepaired.add(code)
      return
    }
    const context: RepairContext = {
      ...media,
      state,
      findings,
      strategy: strongerStrategy(strategy, trackChanges.length > 0 ? 'remux' : 'none'),
      trackChanges
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
    if (fragment?.resyncSubtitles?.length) plan.resyncSubtitles.push(...fragment.resyncSubtitles)
    if (fragment?.videoLevel !== undefined) plan.videoLevel = fragment.videoLevel
    if (fragment?.metadataTags) plan.metadataTags = { ...plan.metadataTags, ...fragment.metadataTags }
  }

  for (const module of REPAIR_MODULES) {
    if (module.when === 'afterPlan') continue
    runRepair(module)
  }

  /* --- the plan as a whole -------------------------------------------- */

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
  plan.unresolved = unresolvedFindings(findings, settled, unrepaired)

  return {
    file,
    verdict: verdictFor(findings),
    findings,
    plan,
    primaryLanguage: media.primary.language,
    primaryLanguageSource: media.primary.source
  }
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
