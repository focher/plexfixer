/**
 * Working out where a repaired file should be written.
 */

import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import type { AppSettings } from '@shared/types.js'

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

function extensionFor(sourcePath: string, targetContainer: 'mp4' | 'mkv'): string {
  const current = extname(sourcePath).toLowerCase()
  return CONTAINER_EXTENSIONS[targetContainer].includes(current) ? extname(sourcePath) : `.${targetContainer}`
}

/** The final destination for a repaired file. */
export function resolveOutputPath(
  sourcePath: string,
  targetContainer: 'mp4' | 'mkv',
  settings: AppSettings,
  /** Root the source was scanned from, used to mirror the tree in output-dir mode. */
  scanRoot?: string
): string {
  const dir = dirname(sourcePath)
  const stem = basename(sourcePath, extname(sourcePath))
  const extension = extensionFor(sourcePath, targetContainer)

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

/** A scratch path beside the destination, so the final rename stays on one volume. */
export function temporaryPathFor(outputPath: string): string {
  const dir = dirname(outputPath)
  const base = basename(outputPath)
  return join(dir, `.plexfixer-${process.pid}-${base}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Append " (2)", " (3)" … until the path is free. */
export async function uniquePath(path: string): Promise<string> {
  if (!(await exists(path))) return path
  const dir = dirname(path)
  const ext = extname(path)
  const stem = basename(path, ext)
  for (let counter = 2; counter < 1000; counter++) {
    const candidate = join(dir, `${stem} (${counter})${ext}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error(`Could not find a free filename near ${path}`)
}

/**
 * Move the original into a backup folder beside it, preserving the name.
 *
 * Returns the backup path, or `undefined` when backups are disabled.
 */
export async function backupOriginal(sourcePath: string, settings: AppSettings): Promise<string | undefined> {
  if (!settings.keepBackups) return undefined
  const backupDir = join(dirname(sourcePath), BACKUP_DIRECTORY)
  await mkdir(backupDir, { recursive: true })
  const target = await uniquePath(join(backupDir, basename(sourcePath)))
  await rename(sourcePath, target)
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
  settings: AppSettings
): Promise<{ finalPath: string; backupPath?: string }> {
  await mkdir(dirname(outputPath), { recursive: true })

  let backupPath: string | undefined
  const replacingOriginal = settings.outputPlacement === 'in-place'

  if (replacingOriginal) {
    if (settings.keepBackups) {
      backupPath = await backupOriginal(sourcePath, settings)
    } else if (await exists(sourcePath)) {
      await rm(sourcePath, { force: true })
    }

    // A container change means the destination has a different name from the
    // source, so something unrelated can already be sitting there — e.g.
    // repairing `Movie.mkv` when a separate `Movie.mp4` exists. Replacing the
    // original was asked for; destroying its neighbour was not.
    if (outputPath !== sourcePath && (await exists(outputPath))) {
      if (settings.keepBackups) {
        await backupOriginal(outputPath, settings)
      } else {
        await rm(outputPath, { force: true })
      }
    }
  }

  // Never clobber an unrelated file that happens to sit at the destination.
  const finalPath = replacingOriginal ? outputPath : await uniquePath(outputPath)
  await rename(temporaryPath, finalPath)
  return { finalPath, backupPath }
}

/** Remove a partially written temporary file; failures here are not fatal. */
export async function discardTemporary(temporaryPath: string): Promise<void> {
  try {
    await rm(temporaryPath, { force: true })
  } catch {
    /* best effort */
  }
}

/** Common root of the scanned inputs, used to mirror trees in output-dir mode. */
export async function scanRootFor(inputPaths: string[], filePath: string): Promise<string | undefined> {
  for (const input of inputPaths) {
    try {
      const info = await stat(input)
      const root = info.isDirectory() ? input : dirname(input)
      if (filePath === input || filePath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return root
    } catch {
      continue
    }
  }
  return undefined
}
