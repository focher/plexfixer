/**
 * Working out where a repaired file should be written.
 */

import type { AppSettings } from '../types.js'
import type { RepairHost } from '../host.js'
import { newId } from '../ids.js'
import { nameFor, type NamingProblem } from './naming.js'

/**
 * A tag that is this run of the app and no other.
 *
 * It used to be the process id, which a webview has no notion of. What it has
 * to be is stable for the life of the app — the leftover sweep decides a
 * temporary file is abandoned partly by it not being ours — and different from
 * whatever another copy is using.
 */
let tag: string | undefined
function temporaryTag(): string {
  tag ??= newId().replace(/-/g, '').slice(0, 12)
  return tag
}

/**
 * Every path here is arithmetic on the *host that holds the file*, which is
 * not always this machine: a Windows client repairing a library on a Linux
 * NAS must not build `C:\\`-style paths for it. The host carries both the path
 * rules and the filesystem operations, and defaults to this machine so the
 * local case reads exactly as it did.
 */

export const BACKUP_DIRECTORY = '.plexfixer-backups'

/**
 * Extensions that already name the target container.
 *
 * `.m4v` is an MP4 file — Apple's name for one with video in it, and what an
 * iTunes library is full of. Rewriting a repaired `.m4v` to `.mp4` renames
 * every file in such a library for no gain: Plex has to re-match them, and the
 * original is left behind under a different name. So an extension that already
 * fits the target container is kept as it is.
 */
const CONTAINER_EXTENSIONS: Record<'mp4' | 'mkv', string[]> = {
  mp4: ['.mp4', '.m4v'],
  mkv: ['.mkv']
}

function extensionFor(sourcePath: string, targetContainer: 'mp4' | 'mkv', host: RepairHost): string {
  const current = host.paths.extname(sourcePath).toLowerCase()
  return CONTAINER_EXTENSIONS[targetContainer].includes(current)
    ? host.paths.extname(sourcePath)
    : `.${targetContainer}`
}

/**
 * The final destination for a repaired file, and why it is named that.
 *
 * Reported together because a rename the user did not ask for is alarming and
 * a rename that did not happen is baffling, and both are answered by the same
 * sentence in the job's log.
 */
export interface OutputPath {
  path: string
  /** Why the naming pattern was not used, when it was not. */
  problem?: NamingProblem
}

/** The final destination for a repaired file. */
export function resolveOutputPath(
  sourcePath: string,
  targetContainer: 'mp4' | 'mkv',
  settings: AppSettings,
  host: RepairHost,
  /** Root the source was scanned from, used to mirror the tree in output-dir mode. */
  scanRoot?: string,
  /**
   * What the file will say about itself once the repair is done — its own
   * tags with anything the plan is about to write over the top. A lookup
   * applied in the same job therefore names the file it just retitled.
   */
  tags: Record<string, string> = {}
): string {
  return resolveOutput(sourcePath, targetContainer, settings, host, scanRoot, tags).path
}

export function resolveOutput(
  sourcePath: string,
  targetContainer: 'mp4' | 'mkv',
  settings: AppSettings,
  host: RepairHost,
  scanRoot?: string,
  tags: Record<string, string> = {}
): OutputPath {
  const { join, dirname, basename, extname, isAbsolute, relative } = host.paths
  const dir = dirname(sourcePath)
  const sourceStem = basename(sourcePath, extname(sourcePath))
  const named = nameFor(settings.filenameTemplate, tags, sourceStem)
  const stem = named.stem
  const problem = named.problem
  const extension = extensionFor(sourcePath, targetContainer, host)

  switch (settings.outputPlacement) {
    case 'in-place':
      return { path: join(dir, `${stem}${extension}`), problem }

    case 'output-dir': {
      const root = settings.outputDirectory
      if (!root || !isAbsolute(root)) {
        // Misconfigured output directory: fall back to a sibling file rather
        // than writing somewhere surprising.
        return { path: join(dir, `${stem}${settings.outputSuffix}${extension}`), problem }
      }
      const relativeDir = scanRoot ? relative(scanRoot, dir) : ''
      const safeRelative = relativeDir.startsWith('..') ? '' : relativeDir
      return { path: join(root, safeRelative, `${stem}${extension}`), problem }
    }

    case 'sibling':
    default:
      // The suffix stays even with a pattern set: beside the original is the
      // one placement where the name *must* differ from the source, and a
      // pattern that happened to reproduce it would overwrite the file.
      return { path: join(dir, `${stem}${settings.outputSuffix}${extension}`), problem }
  }
}

/**
 * Point an ffmpeg command's output at a scratch file, leaving its input alone.
 *
 * The output is the command's last argument. A repair that writes back over
 * its own source carries that same path as its input too, so only the last
 * occurrence may be rewritten: replacing every match pointed ffmpeg's input at
 * a temporary file that does not exist yet, and failed every in-place repair
 * that kept the container.
 */
export function redirectOutput(args: string[], outputPath: string, temporaryPath: string): string[] {
  const redirected = [...args]
  const index = redirected.lastIndexOf(outputPath)
  if (index >= 0) redirected[index] = temporaryPath
  return redirected
}

/** A scratch path beside the destination, so the final rename stays on one volume. */
export function temporaryPathFor(outputPath: string, host: RepairHost): string {
  const dir = host.paths.dirname(outputPath)
  const base = host.paths.basename(outputPath)
  return host.paths.join(dir, `.plexfixer-${temporaryTag()}-${base}`)
}

/** Append " (2)", " (3)" … until the path is free. */
export async function uniquePath(path: string, host: RepairHost): Promise<string> {
  if (!(await host.exists(path))) return path
  const dir = host.paths.dirname(path)
  const ext = host.paths.extname(path)
  const stem = host.paths.basename(path, ext)
  for (let counter = 2; counter < 1000; counter++) {
    const candidate = host.paths.join(dir, `${stem} (${counter})${ext}`)
    if (!(await host.exists(candidate))) return candidate
  }
  throw new Error(`Could not find a free filename near ${path}`)
}

/**
 * Move the original into a backup folder beside it, preserving the name.
 *
 * Returns the backup path, or `undefined` when backups are disabled.
 */
export async function backupOriginal(
  sourcePath: string,
  settings: AppSettings,
  host: RepairHost
): Promise<string | undefined> {
  if (!settings.keepBackups) return undefined
  const backupDir = host.paths.join(host.paths.dirname(sourcePath), BACKUP_DIRECTORY)
  await host.mkdirp(backupDir)
  const target = await uniquePath(host.paths.join(backupDir, host.paths.basename(sourcePath)), host)
  await host.rename(sourcePath, target)
  return target
}

/**
 * Make an instant APFS clone of a file in the backup folder beside it, before
 * the file is edited in place.
 *
 * Returns the backup path, or `undefined` when backups are off or the volume
 * cannot clone — a full copy would cost more than the edit it protects.
 */
export async function cloneToBackup(
  sourcePath: string,
  settings: AppSettings,
  host: RepairHost
): Promise<string | undefined> {
  if (!settings.keepBackups) return undefined
  const backupDir = host.paths.join(host.paths.dirname(sourcePath), BACKUP_DIRECTORY)
  await host.mkdirp(backupDir)
  const target = await uniquePath(host.paths.join(backupDir, host.paths.basename(sourcePath)), host)
  if (!(await host.cloneFile(sourcePath, target))) {
    // The folder may have been created just now for nothing.
    await host.removeEmptyDirectory(backupDir).catch(() => undefined)
    return undefined
  }
  return target
}

/**
 * A promotion that stopped half way and could not be put back.
 *
 * Everything else `promoteOutput` throws leaves the disk as it found it: the
 * original where it was and the repaired file still in its temporary. This is
 * the one case where that is not true, so it carries where both files are —
 * and the caller must not tidy the temporary away, because it is now the only
 * copy of the file in the folder it belongs in.
 */
export class PromoteError extends Error {
  constructor(
    message: string,
    public readonly temporaryPath: string,
    public readonly backupPath: string
  ) {
    super(message)
    this.name = 'PromoteError'
  }
}

export interface Promoted {
  /** Where the repaired file ended up. */
  finalPath: string
  /** Where the original went, when it was kept. */
  backupPath?: string
  /**
   * Set when the repaired file is in place but the original could not be
   * moved or removed afterwards, with the reason. Both files exist; nothing
   * was lost, and the repair is not a failure.
   */
  originalLeft?: string
}

/**
 * Promote the finished temporary file to its destination.
 *
 * The rule the ordering follows: **the original is never the first thing to
 * go.** It used to be — moved aside or deleted, and only then was the repaired
 * file renamed into place — so a rename that failed (a destination held open,
 * a share that dropped) came after the point of no return, and the cleanup
 * that followed removed the repaired file as well. With backups off that left
 * nothing at all.
 *
 *   - Replacing a file under its own name with backups off is one rename,
 *     which swaps the two atomically: there is no moment with neither.
 *   - With backups on the original has to move first, since both cannot hold
 *     the name. If the repaired file then will not go in, the original is put
 *     straight back.
 *   - When the container changes the two have different names, so the
 *     repaired file goes in beside the original and the original is dealt
 *     with afterwards. If that fails there are two files, not none.
 *
 * Nothing that was not asked about is touched. A different file already
 * sitting at the destination — repairing `Movie.mkv` when a separate
 * `Movie.mp4` exists — is left exactly where it is, and the repaired file takes
 * the next free name. Replacing the original was asked for; that file was not.
 */
export async function promoteOutput(
  temporaryPath: string,
  outputPath: string,
  sourcePath: string,
  settings: AppSettings,
  host: RepairHost
): Promise<Promoted> {
  await host.mkdirp(host.paths.dirname(outputPath))

  if (settings.outputPlacement !== 'in-place') {
    // Never clobber an unrelated file that happens to sit at the destination.
    const finalPath = await uniquePath(outputPath, host)
    await host.rename(temporaryPath, finalPath)
    return { finalPath }
  }

  if (outputPath === sourcePath) {
    if (!settings.keepBackups) {
      await host.rename(temporaryPath, outputPath)
      return { finalPath: outputPath }
    }

    const backupPath = await backupOriginal(sourcePath, settings, host)
    if (!backupPath) throw new Error(`Could not back up ${sourcePath}`)
    try {
      await host.rename(temporaryPath, outputPath)
    } catch (error) {
      try {
        await host.rename(backupPath, sourcePath)
      } catch {
        const reason = error instanceof Error ? error.message : String(error)
        throw new PromoteError(
          `The repaired file could not be moved into place (${reason}), and the original could not be put back. ` +
            `Nothing was deleted: the original is at ${backupPath} and the repaired file is at ${temporaryPath}.`,
          temporaryPath,
          backupPath
        )
      }
      // The folder may have been created just now for nothing.
      await host.removeEmptyDirectory(host.paths.dirname(backupPath)).catch(() => undefined)
      throw error
    }
    return { finalPath: outputPath, backupPath }
  }

  const finalPath = await uniquePath(outputPath, host)
  await host.rename(temporaryPath, finalPath)

  try {
    if (settings.keepBackups) {
      return { finalPath, backupPath: await backupOriginal(sourcePath, settings, host) }
    }
    if (await host.exists(sourcePath)) await host.remove(sourcePath)
    return { finalPath }
  } catch (error) {
    return { finalPath, originalLeft: error instanceof Error ? error.message : String(error) }
  }
}

/** Remove a partially written temporary file; failures here are not fatal. */
export async function discardTemporary(temporaryPath: string, host: RepairHost): Promise<void> {
  try {
    await host.remove(temporaryPath)
  } catch {
    /* best effort */
  }
}
