/**
 * Walking the filesystem for media files.
 */

import { lstat, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
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
/**
 * What a directory entry is, when the entry itself does not say.
 *
 * `readdir(withFileTypes)` answers from the directory entry alone, and SMB,
 * NFS and several FUSE filesystems — where a Plex library usually lives —
 * report every entry as an unknown type. Both `isDirectory()` and `isFile()`
 * are then false, which silently hides the entire library. Anything that is
 * not plainly one or the other gets a real `lstat`; symlinks stay excluded on
 * purpose, as documented above.
 */
async function kindOf(full: string, entry: Dirent): Promise<'dir' | 'file' | 'skip'> {
  if (entry.isDirectory()) return 'dir'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) return 'skip'
  try {
    const info = await lstat(full)
    if (info.isSymbolicLink()) return 'skip'
    if (info.isDirectory()) return 'dir'
    if (info.isFile()) return 'file'
  } catch {
    // Vanished mid-walk or unreadable: treat as nothing.
  }
  return 'skip'
}

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
      const kind = await kindOf(full, entry)
      if (kind === 'dir') {
        if (!options.recursive) continue
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (kind === 'file' && isMedia(entry.name)) {
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
