/**
 * Walking the filesystem for media files.
 */

import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** Directories that never contain library media and cost time to walk. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '@eaDir',
  '.AppleDouble',
  '.Trashes',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.plexfixer-backups'
])

export interface WalkOptions {
  extensions: string[]
  recursive: boolean
  /** Guard against symlink loops and pathological trees. */
  maxDepth?: number
}

/**
 * Expand a list of files and folders into a de-duplicated list of media files.
 *
 * Symlinked directories are not followed, which both avoids loops and keeps a
 * library with cross-linked season folders from being scanned twice.
 */
export async function collectMediaFiles(paths: string[], options: WalkOptions): Promise<string[]> {
  const extensions = new Set(options.extensions.map((ext) => ext.toLowerCase().replace(/^\./, '')))
  const found = new Set<string>()

  const isMedia = (filePath: string): boolean => extensions.has(extname(filePath).slice(1).toLowerCase())

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > (options.maxDepth ?? 24)) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory (permissions, disconnected share) — skip quietly;
      // the caller surfaces per-file errors, not per-directory ones.
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('._')) continue // macOS resource forks
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!options.recursive) continue
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile() && isMedia(entry.name)) {
        found.add(full)
      }
    }
  }

  for (const path of paths) {
    try {
      const info = await stat(path)
      if (info.isDirectory()) {
        await walk(path, 0)
      } else if (info.isFile() && isMedia(path)) {
        found.add(path)
      }
    } catch {
      // Non-existent or unreadable input path; ignored here and reported by the
      // scan as a zero-result input.
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b))
}
