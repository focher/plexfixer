/**
 * The temporary files a repair writes before it swaps the result into place.
 *
 * ffmpeg writes to `.plexfixer-<pid>-<name>` beside the destination, and the
 * runner deletes it on success, failure and cancel. Only a crash, or quitting
 * mid-repair, leaves one behind — a full-size copy of a movie nobody will ever
 * finish. A scan finds them, since they carry a media extension; they are not
 * library files, and once stale they are removed.
 */

/** Matches the name `temporaryPathFor` gives, not anything a person would. */
const TEMPORARY_NAME = /^\.plexfixer-\d+-./

/** A repair writes continuously, so a file this recently changed may still be in use. */
export const TEMPORARY_QUIET_MS = 10 * 60 * 1000

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function isTemporaryName(path: string): boolean {
  return TEMPORARY_NAME.test(baseName(path))
}

/**
 * Whether a temporary file can go: it is not being written by a repair this
 * app is running, and has not changed for long enough that nothing else is
 * writing it either (another session, say, or another machine on a share).
 */
export function isStaleTemporary(
  path: string,
  modifiedMs: number | undefined,
  now: number,
  active: ReadonlySet<string>
): boolean {
  if (!isTemporaryName(path) || active.has(path)) return false
  if (modifiedMs == null || !Number.isFinite(modifiedMs)) return false
  return now - modifiedMs >= TEMPORARY_QUIET_MS
}
