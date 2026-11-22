/**
 * The four track modules, run together.
 *
 * Which audio track plays, which subtitle comes up and what language anything
 * claims to be are one question in four parts, and the parts depend on each
 * other: the language fixes have to be decided before the default audio can be
 * chosen from them, and the default audio decides whether subtitles belong on
 * screen at all. The modules express that by running in order and reading what
 * the ones before them concluded.
 *
 * This runs just those four, for the places that want the answer on its own
 * rather than a whole analysis.
 */

import type { AppSettings, Finding, MediaFile, TrackPlanChange } from '../../types.js'
import { audioStreams, subtitleStreams, videoStreams, type PrimaryLanguage } from '../tracks.js'
import { initialState, isModuleEnabled, mergeSignals, type CheckModule } from './framework.js'
import { trackLanguageMissing } from './checks/track-language-missing.js'
import { trackLanguageNonstandard } from './checks/track-language-nonstandard.js'
import { trackAudioMissing } from './checks/track-audio-missing.js'
import { trackDefaultAudio } from './checks/track-default-audio.js'
import { trackDefaultSubtitle } from './checks/track-default-subtitle.js'
import { trackForcedSubtitle } from './checks/track-forced-subtitle.js'

/** In the order they have to run. */
export const TRACK_CHECK_MODULES: readonly CheckModule[] = [
  trackLanguageMissing,
  trackLanguageNonstandard,
  trackAudioMissing,
  trackDefaultAudio,
  trackDefaultSubtitle,
  trackForcedSubtitle
]

export interface TrackResolution {
  /** Stream index of the track that should be the default audio, if any. */
  defaultAudioIndex?: number
  /** Language actually chosen for the default audio track. */
  defaultAudioLanguage?: string
  /** Stream index of the track that should be the default subtitle, if any. */
  defaultSubtitleIndex?: number
  /** Language fixes and flag changes to apply. */
  changes: TrackPlanChange[]
  findings: Finding[]
}

export function resolveTracks(file: MediaFile, settings: AppSettings, primary: PrimaryLanguage): TrackResolution {
  const media = {
    file,
    settings,
    video: videoStreams(file),
    audio: audioStreams(file),
    subtitles: subtitleStreams(file),
    primary
  }

  let state = initialState(settings)
  const findings: Finding[] = []

  for (const module of TRACK_CHECK_MODULES) {
    if (!isModuleEnabled(module, settings)) continue
    const result = module.run({ ...media, state })
    if (result.findings?.length) findings.push(...result.findings)
    state = mergeSignals(state, result.signals)
  }

  return {
    defaultAudioIndex: state.defaultAudioIndex,
    defaultAudioLanguage: state.defaultAudioLanguage,
    defaultSubtitleIndex: state.defaultSubtitleIndex,
    changes: state.trackChanges,
    findings
  }
}
