/**
 * The module framework: what a check is, what a repair is, and how they talk.
 *
 * The compatibility rules used to be one long function. Everything it knew was
 * true at once, and the only way to learn what it looked for was to read all of
 * it — which also meant there was nowhere to put "and this is why we bother",
 * and no way to turn one rule off without editing code.
 *
 * So the rules are modules. Each one is a small file that says, in plain
 * English, what it looks for and how it decides, and then does exactly that and
 * nothing else. A **check** reads a file and reports what is wrong with it. A
 * **repair** reads what the checks concluded and says what to do about it. Each
 * can be switched off on its own.
 *
 * Two things make that work without the modules knowing about each other:
 *
 * - **Findings are the shared language.** A check raises a finding code; a
 *   repair declares which codes it answers. Neither imports the other.
 * - **Checks run in order and build up a `ScanState`.** Some questions cannot
 *   be asked until an earlier one is answered — whether a subtitle track can
 *   stay depends on the container, and the container depends on what the video
 *   and audio turned out to be. Rather than pretend the rules are independent,
 *   the registry's order *is* the pipeline, and each module is handed what the
 *   ones before it concluded.
 */

import type {
  AppSettings,
  AudioStream,
  CompatibilityAudioSpec,
  Finding,
  FindingCode,
  MediaFile,
  PlanAction,
  PlanStrategy,
  RepairPlan,
  SubtitleStream,
  TrackPlanChange,
  VideoStream,
  VideoTranscodeSpec
} from '../../types.js'
import type { PrimaryLanguage } from '../tracks.js'
import type { MetadataEdit } from '../metadata.js'

/* ------------------------------------------------------------------ *
 * What every module says about itself
 * ------------------------------------------------------------------ */

/**
 * The part of a module that is written for a person rather than for the code.
 *
 * Every field here ends up on screen under Settings → Modules, so it is prose,
 * not a code comment: no identifiers, no ffmpeg flags, and no assumption that
 * the reader knows what a "tx3g track" is before the sentence explains it.
 */
export interface ModuleDescription {
  /**
   * Stable identifier, stored in settings when the module is switched off.
   * Never renamed once shipped: a rename silently switches a module back on
   * for everyone who had turned it off.
   */
  id: string
  /** A few words, as a heading. */
  title: string
  /** One line, for the list. */
  summary: string
  /** Plain English: what this module is looking for, or what it fixes. */
  whatItDoes: string
  /** Plain English: how it decides — the actual rule, in words. */
  howItWorks: string
  /** Plain English: what you lose by switching it off. */
  ifDisabled: string
  /**
   * Set only by a rule the user wrote.
   *
   * Absent means the module ships with the app: it can be switched off, but
   * its text and its logic are the app's rather than yours, so Settings offers
   * no way to edit or delete it. There is nowhere to save such an edit to — a
   * built-in module is code, not data — and a screen that offered the edit
   * anyway would be lying about what it could keep.
   */
  source?: 'custom'
  /**
   * Ships quiet, and runs only once somebody asks for it.
   *
   * For a rule that is right but not wanted by default: one that reports
   * something true of most of a library and clears only by hand, one file at
   * a time. Arriving switched on, it would hand every user a few hundred rows
   * they cannot work through, and the cost of that is not the rows — it is
   * that the next module's rows get ignored too.
   */
  startsOff?: true
}

/** True for a rule the user wrote, which is the only kind that can be edited. */
export function isUserModule(module: ModuleDescription): boolean {
  return module.source === 'custom'
}

/* ------------------------------------------------------------------ *
 * What the checks are given, and what they conclude
 * ------------------------------------------------------------------ */

/**
 * What the checks have concluded so far.
 *
 * This is the running total of everything decided about a file: the findings
 * are what a person reads, and this is what the repairs act on. Later checks
 * read it too — `targetContainer` in particular, which several of them need
 * and none of them decides for itself.
 */
export interface ScanState {
  /** Where the repaired file is headed. Starts as the setting, refined by the container checks. */
  targetContainer: 'mp4' | 'mkv'
  /** The container is changing, which is a reason to rewrite the file on its own. */
  containerChange: boolean

  /** The video stream cannot be direct played as it is and has to be re-encoded. */
  needsTranscode: boolean
  /** Any re-encode has to deinterlace. */
  needsDeinterlace: boolean
  /** The source is more than 8-bit or not 4:2:0, so the pixel format has to change. */
  needsPixelFormatChange: boolean
  /** Re-encode through libplacebo, applying the Dolby Vision layer and writing HDR10. */
  convertDolbyVision: boolean
  /** Downscale to this height during a re-encode. */
  scaleHeight?: number
  /** Relabel the H.264 level to this, losslessly, when the video is being copied. */
  relabelLevel?: number
  /** The MP4 codec tag for HEVC is wrong — metadata only, no re-encode. */
  needsTagFix: boolean

  /** Audio streams that no mainstream client can decode. */
  incompatibleAudio: AudioStream[]
  /** Not one audio track is playable everywhere, and the setting says to add one. */
  needsCompatibilityAudio: boolean

  /** Streams that cannot travel into the target container and have to be left out. */
  dropStreams: number[]
  /**
   * Subtitle streams someone has explicitly asked to have retimed.
   *
   * Separate from the ones the app picks for itself: these were asked for, so
   * they are measured whether or not the setting asking for it is on.
   */
  resyncSubtitles: SubtitleStream[]

  /** What rules the user wrote have asked for. */
  userRequests: UserRequest[]

  /** Language tags and default/forced flags to write. */
  trackChanges: TrackPlanChange[]
  /** The audio track chosen to be the default. */
  defaultAudioIndex?: number
  /** The language that track turned out to be in. */
  defaultAudioLanguage?: string
  /** The subtitle track chosen to be the default, if any should be. */
  defaultSubtitleIndex?: number
}

/**
 * What a check may add to the state.
 *
 * Deliberately additive and declarative rather than a function that edits the
 * state: a module says what it concluded, and the framework works out what that
 * means for everything concluded so far. Booleans can only be turned on, lists
 * are appended to, and a plain value replaces what was there.
 */
export interface ScanSignals {
  targetContainer?: 'mp4' | 'mkv'
  containerChange?: boolean
  needsTranscode?: boolean
  needsDeinterlace?: boolean
  needsPixelFormatChange?: boolean
  convertDolbyVision?: boolean
  scaleHeight?: number
  relabelLevel?: number
  needsTagFix?: boolean
  incompatibleAudio?: AudioStream[]
  needsCompatibilityAudio?: boolean
  dropStreams?: number[]
  resyncSubtitles?: SubtitleStream[]
  trackChanges?: TrackPlanChange[]
  userRequests?: UserRequest[]
  defaultAudioIndex?: number
  defaultAudioLanguage?: string
  defaultSubtitleIndex?: number
}

/**
 * Something a rule the user wrote has asked the app to do.
 *
 * A hand-written rule never describes *how* a file is written — it asks for one
 * of the things the app already knows how to do, and names itself so the plan
 * can say whose idea it was. That is the boundary: a rule can direct the
 * repairs, and cannot invent one.
 */
export interface UserRequest {
  /** The rule's own name, as the plan will credit it. */
  module: string
  kind: 'rewrite' | 'drop'
  /** The tracks the rule matched; empty for a request about the whole file. */
  streamIndexes: number[]
}

/** The file, pulled apart the way every module wants it. */
export interface MediaContext {
  readonly file: MediaFile
  readonly settings: AppSettings
  /**
   * What a person has asked for by hand, when this analysis is previewing an
   * edit rather than describing a file as found.
   */
  readonly edits?: MetadataEdit
  /** Real video tracks — embedded cover art is filtered out. */
  readonly video: readonly VideoStream[]
  readonly audio: readonly AudioStream[]
  readonly subtitles: readonly SubtitleStream[]
  /** The language the film or episode is *in*, and how that was worked out. */
  readonly primary: PrimaryLanguage
}

/** What a check is handed. */
export interface CheckContext extends MediaContext {
  /** What the checks before this one concluded. */
  readonly state: Readonly<ScanState>
}

/** What a check hands back. */
export interface CheckResult {
  findings?: Finding[]
  signals?: ScanSignals
}

export interface CheckModule extends ModuleDescription {
  /**
   * The findings this check can raise.
   *
   * Written down rather than discovered by running it, so Settings can say what
   * a module reports without analysing a file, and so a repair can be tied back
   * to the check that gives it work.
   */
  raises: readonly FindingCode[]
  run(context: CheckContext): CheckResult
}

/* ------------------------------------------------------------------ *
 * What the repairs are given, and what they produce
 * ------------------------------------------------------------------ */

/** What a repair is handed: the file, what the checks concluded, and what they said. */
export interface RepairContext extends MediaContext {
  readonly state: Readonly<ScanState>
  readonly findings: readonly Finding[]
  /**
   * How much work the run is turning out to be, as it stands.
   *
   * Only settled for a module that runs `afterPlan`; an ordinary repair is
   * still being asked what it wants done, so this is a running total and reads
   * as one.
   */
  readonly strategy: PlanStrategy
}

/** The pieces of a repair plan a module can contribute. */
export interface PlanFragment {
  metadataTags?: Record<string, string>
  videoTranscode?: VideoTranscodeSpec
  addCompatibilityAudio?: CompatibilityAudioSpec
  resyncSubtitles?: RepairPlan['resyncSubtitles']
  videoLevel?: number
}

export interface RepairResult {
  /** Steps shown in the plan, each with its own line. */
  actions?: PlanAction[]
  /**
   * Phrases folded into the single "Remux: …" line.
   *
   * Four separate fixes — rewrapping, moving the index, retagging, relabelling —
   * are one pass over the file and read better as one sentence than as four
   * lines that all say "stream copy". They are still four modules.
   */
  remuxParts?: string[]
  /** Metadata changes to write. */
  trackChanges?: TrackPlanChange[]
  /** Streams to leave out of the output. */
  dropStreams?: number[]
  /** The least this repair needs the run to be; the strongest across all modules wins. */
  strategy?: PlanStrategy
  /** Everything else the plan needs. */
  plan?: PlanFragment
  /**
   * A last word on the findings.
   *
   * For the repair that discovers it cannot do what the finding promised. It
   * rewrites the finding to say so rather than leaving a repair listed that
   * will not happen.
   */
  amendFindings?: (findings: Finding[]) => Finding[]
  /**
   * A last word on the metadata changes, for the same reason.
   *
   * Withdrawing a change another module asked for, where this one knows it
   * would not have the effect it promises — or would undo itself.
   */
  amendTrackChanges?: (changes: TrackPlanChange[]) => TrackPlanChange[]
}

export interface RepairModule extends ModuleDescription {
  /** The finding codes this repair answers. */
  answers: readonly FindingCode[]
  /**
   * When it runs. `fix` — the default — is a repair that changes what the plan
   * does. `afterPlan` is for the handful that only describe a consequence of
   * the plan, and so cannot run until it is settled.
   */
  when?: 'fix' | 'afterPlan'
  run(context: RepairContext): RepairResult
}

export type AnyModule = CheckModule | RepairModule

/* ------------------------------------------------------------------ *
 * Running them
 * ------------------------------------------------------------------ */

/** A fresh state, before any check has run. */
export function initialState(settings: AppSettings): ScanState {
  return {
    targetContainer: settings.targetContainer,
    containerChange: false,
    needsTranscode: false,
    needsDeinterlace: false,
    needsPixelFormatChange: false,
    convertDolbyVision: false,
    needsTagFix: false,
    incompatibleAudio: [],
    needsCompatibilityAudio: false,
    dropStreams: [],
    resyncSubtitles: [],
    userRequests: [],
    trackChanges: []
  }
}

/**
 * Fold one check's conclusions into the running state.
 *
 * Booleans only ever go from false to true: two checks can each decide the
 * video has to be re-encoded, and neither may un-decide it for the other.
 */
export function mergeSignals(state: ScanState, signals: ScanSignals | undefined): ScanState {
  if (!signals) return state
  const next: ScanState = { ...state }

  if (signals.targetContainer) next.targetContainer = signals.targetContainer
  if (signals.containerChange) next.containerChange = true
  if (signals.needsTranscode) next.needsTranscode = true
  if (signals.needsDeinterlace) next.needsDeinterlace = true
  if (signals.needsPixelFormatChange) next.needsPixelFormatChange = true
  if (signals.convertDolbyVision) next.convertDolbyVision = true
  if (signals.needsTagFix) next.needsTagFix = true
  if (signals.needsCompatibilityAudio) next.needsCompatibilityAudio = true

  if (signals.scaleHeight !== undefined) next.scaleHeight = signals.scaleHeight
  if (signals.relabelLevel !== undefined) next.relabelLevel = signals.relabelLevel
  if (signals.defaultAudioIndex !== undefined) next.defaultAudioIndex = signals.defaultAudioIndex
  if (signals.defaultAudioLanguage !== undefined) next.defaultAudioLanguage = signals.defaultAudioLanguage
  if (signals.defaultSubtitleIndex !== undefined) next.defaultSubtitleIndex = signals.defaultSubtitleIndex

  if (signals.incompatibleAudio?.length) next.incompatibleAudio = [...state.incompatibleAudio, ...signals.incompatibleAudio]
  if (signals.dropStreams?.length) next.dropStreams = [...state.dropStreams, ...signals.dropStreams]
  if (signals.resyncSubtitles?.length) next.resyncSubtitles = [...state.resyncSubtitles, ...signals.resyncSubtitles]
  if (signals.trackChanges?.length) next.trackChanges = [...state.trackChanges, ...signals.trackChanges]
  if (signals.userRequests?.length) next.userRequests = [...state.userRequests, ...signals.userRequests]

  return next
}

/** Strongest wins: a run that re-encodes video also remuxes, but not the other way round. */
const STRATEGY_RANK: Record<PlanStrategy, number> = {
  none: 0,
  remux: 1,
  'transcode-audio': 2,
  'transcode-video': 3
}

export function strongerStrategy(a: PlanStrategy, b: PlanStrategy): PlanStrategy {
  return STRATEGY_RANK[b] > STRATEGY_RANK[a] ? b : a
}

/* ------------------------------------------------------------------ *
 * Switching them off
 * ------------------------------------------------------------------ */

/**
 * Whether a module runs.
 *
 * Everything is on unless it has been named in `disabledModules`, so a module
 * added in a later version is on for everyone rather than silently absent for
 * anyone who has ever touched this screen.
 */
/**
 * Just enough of a module to say whether it runs.
 *
 * A rule the user wrote can be too broken to build a module from and still
 * has to be switchable, so this asks for the two fields that decide it rather
 * than for a whole module.
 */
export type ModuleSwitch = Pick<ModuleDescription, 'id' | 'startsOff'>

export function isModuleEnabled(module: ModuleSwitch, settings: AppSettings): boolean {
  return module.startsOff
    ? settings.enabledModules.includes(module.id)
    : !settings.disabledModules.includes(module.id)
}

/** The same list with one module switched on or off, kept sorted and unique. */
export function withModuleEnabled(
  module: ModuleSwitch,
  enabled: boolean,
  settings: AppSettings
): Pick<AppSettings, 'disabledModules' | 'enabledModules'> {
  const drop = (list: readonly string[]): string[] => list.filter((entry) => entry !== module.id)
  const add = (list: readonly string[]): string[] => [...new Set([...list, module.id])].sort()

  // Whichever list this module does not belong in is cleared of it either
  // way: an id left in both says two things at once, and a module that is
  // marked `startsOff` later would then come back on for whoever had once
  // switched it off.
  return module.startsOff
    ? {
        disabledModules: drop(settings.disabledModules),
        enabledModules: enabled ? add(settings.enabledModules) : drop(settings.enabledModules)
      }
    : {
        enabledModules: drop(settings.enabledModules),
        disabledModules: enabled ? drop(settings.disabledModules) : add(settings.disabledModules)
      }
}

export function runningModules<T extends ModuleDescription>(
  modules: readonly T[],
  settings: AppSettings
): T[] {
  return modules.filter((module) => isModuleEnabled(module, settings))
}
