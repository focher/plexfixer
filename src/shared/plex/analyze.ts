/**
 * Compatibility analysis and repair planning.
 *
 * `analyzeFile` is pure: probe output in, findings and a plan out. That keeps
 * the rules unit-testable and lets the UI preview exactly what a repair will do
 * before anything touches the disk.
 *
 * The rules themselves live one directory down, in `modules/` — one small file
 * per thing that can be wrong with a file, and one per thing that can be done
 * about it, each explaining itself in plain English and each able to be
 * switched off on its own. This file is the door they are all behind, so that
 * everything calling into the analysis carries on calling one function.
 */

import type { AnalysisResult, AppSettings, MediaFile } from '../types.js'
import type { MetadataEdit } from './metadata.js'
import { analyzeWithModules } from './modules/engine.js'

/**
 * `edits` is what a person asked for by hand, when there is any. Passing it
 * produces the plan for that edit — the same preview every other repair gets,
 * before anything is written.
 */
export function analyzeFile(file: MediaFile, settings: AppSettings, edits?: MetadataEdit): AnalysisResult {
  return analyzeWithModules(file, settings, edits)
}
