/**
 * Resolving the repair mode for a file.
 *
 * A file-level override wins; failing that, the nearest ancestor folder with an
 * override applies; failing that, the global default. That nesting is the whole
 * point: set the `Anime` folder to force-transcode, then leave one episode on
 * report-only, and the episode keeps its own setting.
 *
 * Pure, so the main process (which decides what a job actually does) and the
 * renderer (which has to show the same answer before anything runs) share one
 * implementation and cannot drift apart.
 */

import type { ModeOverrides, RepairMode } from './types.js'

/** Where a resolved mode came from, for display. */
export type ModeSource = 'file' | 'folder' | 'default'

export interface ResolvedMode {
  mode: RepairMode
  source: ModeSource
  /** The override key that won, exactly as it is stored. Absent for 'default'. */
  from?: string
}

/**
 * A path reduced to something comparable.
 *
 * Windows paths may arrive with either separator and in either case — the
 * folder picker and the scanner do not always agree on the drive letter's case
 * — so a Windows path is lowercased. POSIX paths are left alone, because there
 * `Anime` and `anime` really are two folders.
 */
function comparable(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = path.includes('\\') || /^[a-zA-Z]:/.test(slashed)
  return windows ? slashed.toLowerCase() : slashed
}

/** The mode for `path`, and why. */
export function resolveMode(path: string, overrides: ModeOverrides, fallback: RepairMode): ResolvedMode {
  const target = comparable(path)

  let best: { length: number; mode: RepairMode; from: string } | undefined
  for (const [raw, mode] of Object.entries(overrides)) {
    const candidate = comparable(raw)
    if (candidate === target) return { mode, source: 'file', from: raw }
    // The separator matters: `/Media/Anime2` must not inherit from `/Media/Anime`.
    if (target.startsWith(`${candidate}/`)) {
      if (!best || candidate.length > best.length) best = { length: candidate.length, mode, from: raw }
    }
  }

  if (best) return { mode: best.mode, source: 'folder', from: best.from }
  return { mode: fallback, source: 'default' }
}

/**
 * The stored key that is an override *on this exact path*, if there is one.
 *
 * Looking it up by comparison rather than by `overrides[path]` so a folder
 * added through the picker still matches the same folder as the scanner spells
 * it, which on Windows is not always the same string.
 */
export function findOverrideKey(path: string, overrides: ModeOverrides): string | undefined {
  const target = comparable(path)
  for (const raw of Object.keys(overrides)) if (comparable(raw) === target) return raw
  return undefined
}

/** The mode alone, for callers that do not care where it came from. */
export function effectiveMode(path: string, overrides: ModeOverrides, fallback: RepairMode): RepairMode {
  return resolveMode(path, overrides, fallback).mode
}

/**
 * The mode a repair actually runs in.
 *
 * `explicit` is a mode chosen for this one repair — the "Force transcode
 * selected" buttons — and wins over the file's own, with one exception:
 * report-only. A file, or a folder, set to report-only is never written to,
 * however the repair was started; otherwise the setting would only be a
 * suggestion.
 */
export function repairModeFor(
  path: string,
  overrides: ModeOverrides,
  fallback: RepairMode,
  explicit?: RepairMode
): RepairMode {
  const own = resolveMode(path, overrides, fallback).mode
  if (own === 'report') return 'report'
  return explicit ?? own
}

export const MODE_LABEL: Record<RepairMode, string> = {
  report: 'Report only',
  'safe-remux': 'Safe remux',
  'force-transcode': 'Force transcode'
}
