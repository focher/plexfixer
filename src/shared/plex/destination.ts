/**
 * Where one repair run writes, as against where Settings says to write.
 *
 * `targetPathFor` reads the destination off the settings it is handed, so an
 * override is applied by handing that run a copy of the settings with the
 * three output fields replaced. Nothing downstream — the runner, the command
 * builder, the promotion — learns that there is such a thing as an override,
 * which is the point: there is one answer to "where does this go", and it is
 * always in the settings the job was queued with.
 */

import type { AppSettings, OutputOverride } from '../types.js'

/** The settings a run uses, with its destination replaced. */
export function withOutput(settings: AppSettings, override?: OutputOverride): AppSettings {
  if (!override) return settings
  const directory = override.directory?.trim()
  return {
    ...settings,
    outputPlacement: override.placement,
    // Kept rather than blanked when the override does not name one: only
    // `output-dir` uses it, and the dialog does not offer that without a
    // folder, so an empty string here could only lose the standing setting.
    outputDirectory: directory && directory.length > 0 ? directory : settings.outputDirectory
  }
}

/**
 * One line saying where the repaired files land, for the dialog that asks.
 *
 * Written against the *effective* settings, so the same function describes
 * both the standing setting and an override and the two cannot drift.
 */
export function describeDestination(settings: AppSettings): string {
  switch (settings.outputPlacement) {
    case 'in-place':
      return settings.keepBackups
        ? 'Each original is replaced, and kept in a .plexfixer-backups folder beside it.'
        : 'Each original is replaced. Backups are off, so the original is not kept.'

    case 'output-dir': {
      const directory = settings.outputDirectory.trim()
      if (directory.length === 0) {
        // `targetPathFor` falls back to a sibling file rather than writing
        // somewhere surprising, and saying so is better than naming a folder
        // that is not set.
        return 'No output folder is set, so repaired files go beside their originals.'
      }
      return `Into ${directory}, in a folder per film, mirroring the library.`
    }

    case 'sibling':
    default:
      return `Beside each original, with "${settings.outputSuffix}" added to the name.`
  }
}

/**
 * Whether a run may start.
 *
 * The one thing the dialog must not let through is "into a separate folder"
 * with no folder named: that silently becomes a sibling write, which is the
 * one answer the user did not pick.
 */
export function destinationProblem(override: OutputOverride): string | undefined {
  if (override.placement !== 'output-dir') return undefined
  const directory = override.directory?.trim() ?? ''
  if (directory.length === 0) return 'Choose the folder to write into.'
  return undefined
}
