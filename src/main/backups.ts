/**
 * The record of repair backups, and removing them once they expire.
 *
 * Kept as JSON in Electron's `userData` beside the settings, written the same
 * atomic way. Every backup a repair makes is recorded with when it was made;
 * `pruneBackups` removes the ones older than the retention setting, and
 * `removeAllBackups` clears out every backup folder under the library —
 * including ones made before this record existed.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { expiredBackups, type BackupRecord } from '@shared/backups.js'
import type { Host } from './host.js'
import { BACKUP_DIRECTORY } from './jobs/output.js'

function filePath(): string {
  return join(app.getPath('userData'), 'backups.json')
}

async function load(): Promise<BackupRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath(), 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as BackupRecord[]) : []
  } catch {
    return []
  }
}

async function persist(records: BackupRecord[]): Promise<void> {
  const target = filePath()
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify(records, null, 2), 'utf8')
  await rename(temporary, target)
}

// Reads and writes go one at a time: two repairs finishing together must not
// each write back a list missing the other's backup.
let queue: Promise<unknown> = Promise.resolve()
function serially<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

export function recordBackup(record: BackupRecord): Promise<void> {
  return serially(async () => {
    const records = (await load()).filter((entry) => entry.path !== record.path)
    records.push(record)
    await persist(records)
  })
}

/** Remove a backup file, then its folder if that leaves it empty. */
async function removeBackupFile(path: string, host: Host): Promise<void> {
  await host.remove(path)
  const folder = host.paths.dirname(path)
  if (host.paths.basename(folder) !== BACKUP_DIRECTORY) return
  // Finder leaves a .DS_Store in any folder it has shown; it is not a reason
  // to keep an otherwise empty backup folder.
  const left = await host.list(folder).catch(() => undefined)
  if (left && left.length === 1 && left[0]?.name === '.DS_Store') {
    await host.remove(host.paths.join(folder, '.DS_Store')).catch(() => undefined)
  }
  // Fails, harmlessly, when anything else is still in the folder.
  await host.removeEmptyDirectory(folder).catch(() => undefined)
}

export interface PruneResult {
  removed: number
  bytes: number
}

/**
 * Remove this host's backups that are older than `retentionDays` (0 keeps
 * them), and forget records whose file is already gone.
 */
export function pruneBackups(host: Host, retentionDays: number, now = Date.now()): Promise<PruneResult> {
  return serially(async () => {
    const records = await load()
    const expired = new Set(expiredBackups(records, now, retentionDays, host.label))
    const kept: BackupRecord[] = []
    let removed = 0
    let bytes = 0
    for (const record of records) {
      if (record.host !== host.label) {
        kept.push(record)
        continue
      }
      const info = await host.stat(record.path)
      if (!info) {
        // Gone from a folder that is still there: removed by hand, so forget
        // it. If the folder is missing too, the drive is probably just not
        // mounted, and the record has to wait for it to come back.
        const folder = host.paths.dirname(host.paths.dirname(record.path))
        if (!(await host.stat(folder))) kept.push(record)
        continue
      }
      if (!expired.has(record)) {
        kept.push(record)
        continue
      }
      try {
        await removeBackupFile(record.path, host)
        removed++
        // A clone shares its data with the file, so removing it frees nothing.
        if (!record.clone) bytes += info.sizeBytes
      } catch (error) {
        console.warn(`Could not remove the backup ${record.path}`, error)
        kept.push(record)
      }
    }
    if (kept.length !== records.length) await persist(kept)
    return { removed, bytes }
  })
}

export interface BackupSummary {
  files: string[]
  bytes: number
}

/**
 * Every file in a backup folder under these roots. Folders are walked through
 * the host, so this finds backups the record does not know about too.
 */
export async function findBackups(roots: string[], host: Host, maxDepth = 8): Promise<BackupSummary> {
  const files: string[] = []
  let bytes = 0
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    const entries = await host.list(directory).catch(() => [])
    for (const entry of entries) {
      const full = host.paths.join(directory, entry.name)
      if (!entry.isDirectory) continue
      if (entry.name === BACKUP_DIRECTORY) {
        for (const backup of await host.list(full).catch(() => [])) {
          if (backup.isDirectory) continue
          files.push(host.paths.join(full, backup.name))
          bytes += backup.sizeBytes ?? 0
        }
      } else if (!entry.name.startsWith('.')) {
        await visit(full, depth + 1)
      }
    }
  }
  for (const root of roots) {
    // A root that is itself a file has no folders to look in.
    const info = await host.stat(root)
    if (info?.isDirectory) await visit(root, 0)
  }
  return { files, bytes }
}

/** Remove every backup under these roots, and their record entries. */
export function removeAllBackups(roots: string[], host: Host): Promise<PruneResult> {
  return serially(async () => {
    const { files, bytes } = await findBackups(roots, host)
    let removed = 0
    for (const file of files) {
      try {
        await removeBackupFile(file, host)
        removed++
      } catch (error) {
        console.warn(`Could not remove the backup ${file}`, error)
      }
    }
    const gone = new Set(files)
    const records = await load()
    const kept = records.filter((record) => !(record.host === host.label && gone.has(record.path)))
    if (kept.length !== records.length) await persist(kept)
    return { removed, bytes }
  })
}
