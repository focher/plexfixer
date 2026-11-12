/**
 * Working out where a repaired file should be written.
 */

import type { AppSettings } from '@shared/types.js'
import { localHost, type Host } from '../host.js'

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

function extensionFor(sourcePath: string, targetContainer: 'mp4' | 'mkv', host: Host): string {
  const current = host.paths.extname(sourcePath).toLowerCase()
  return CONTAINER_EXTENSIONS[targetContainer].includes(current)
    ? host.paths.extname(sourcePath)
    : `.${targetContainer}`
}

/** The final destination for a repaired file. */
export function resolveOutputPath(
  sourcePath: string,
  targetContainer: 'mp4' | 'mkv',
  settings: AppSettings,
  /** Root the source was scanned from, used to mirror the tree in output-dir mode. */
  scanRoot?: string,
  host: Host = localHost()
): string {
  const { join, dirname, basename, extname, isAbsolute, relative } = host.paths
  const dir = dirname(sourcePath)
  const stem = basename(sourcePath, extname(sourcePath))
  const extension = extensionFor(sourcePath, targetContainer, host)

  switch (settings.outputPlacement) {
    case 'in-place':
      return join(dir, `${stem}${extension}`)

    case 'output-dir': {
      const root = settings.outputDirectory
      if (!root || !isAbsolute(root)) {
        // Misconfigured output directory: fall back to a sibling file rather
        // than writing somewhere surprising.
        return join(dir, `${stem}${settings.outputSuffix}${extension}`)
      }
      const relativeDir = scanRoot ? relative(scanRoot, dir) : ''
      const safeRelative = relativeDir.startsWith('..') ? '' : relativeDir
      return join(root, safeRelative, `${stem}${extension}`)
    }

    case 'sibling':
    default:
      return join(dir, `${stem}${settings.outputSuffix}${extension}`)
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
export function temporaryPathFor(outputPath: string, host: Host = localHost()): string {
  const dir = host.paths.dirname(outputPath)
  const base = host.paths.basename(outputPath)
  return host.paths.join(dir, `.plexfixer-${process.pid}-${base}`)
}

/** Append " (2)", " (3)" … until the path is free. */
export async function uniquePath(path: string, host: Host = localHost()): Promise<string> {
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
  host: Host = localHost()
): Promise<string | undefined> {
  if (!settings.keepBackups) return undefined
  const backupDir = host.paths.join(host.paths.dirname(sourcePath), BACKUP_DIRECTORY)
  await host.mkdirp(backupDir)
  const target = await uniquePath(host.paths.join(backupDir, host.paths.basename(sourcePath)), host)
  await host.rename(sourcePath, target)
  return target
}

/**
 * Promote the finished temporary file to its destination.
 *
 * In-place mode has to deal with the original first — moved aside when backups
 * are on, deleted when they are not — because a container change means the
 * output has a different name and would otherwise leave both files behind.
 */
export async function promoteOutput(
  temporaryPath: string,
  outputPath: string,
  sourcePath: string,
  settings: AppSettings,
  host: Host = localHost()
): Promise<{ finalPath: string; backupPath?: string }> {
  await host.mkdirp(host.paths.dirname(outputPath))

  let backupPath: string | undefined
  const replacingOriginal = settings.outputPlacement === 'in-place'

  if (replacingOriginal) {
    if (settings.keepBackups) {
      backupPath = await backupOriginal(sourcePath, settings, host)
    } else if (await host.exists(sourcePath)) {
      await host.remove(sourcePath)
    }

    // A container change means the destination has a different name from the
    // source, so something unrelated can already be sitting there — e.g.
    // repairing `Movie.mkv` when a separate `Movie.mp4` exists. Replacing the
    // original was asked for; destroying its neighbour was not.
    if (outputPath !== sourcePath && (await host.exists(outputPath))) {
      if (settings.keepBackups) {
        await backupOriginal(outputPath, settings, host)
      } else {
        await host.remove(outputPath)
      }
    }
  }

  // Never clobber an unrelated file that happens to sit at the destination.
  const finalPath = replacingOriginal ? outputPath : await uniquePath(outputPath, host)
  await host.rename(temporaryPath, finalPath)
  return { finalPath, backupPath }
}

/** Remove a partially written temporary file; failures here are not fatal. */
export async function discardTemporary(temporaryPath: string, host: Host = localHost()): Promise<void> {
  try {
    await host.remove(temporaryPath)
  } catch {
    /* best effort */
  }
}

/** Common root of the scanned inputs, used to mirror trees in output-dir mode. */
export async function scanRootFor(
  inputPaths: string[],
  filePath: string,
  host: Host = localHost()
): Promise<string | undefined> {
  const { sep, dirname } = host.paths
  for (const input of inputPaths) {
    const info = await host.stat(input)
    if (!info) continue
    const root = info.isDirectory ? input : dirname(input)
    if (filePath === input || filePath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return root
  }
  return undefined
}
