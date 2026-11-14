/**
 * The record of repair backups, and removing them once they expire.
 *
 * Every backup a repair makes is recorded with when it was made, because a
 * moved file keeps the dates it has had for years and cannot say. `prune`
 * removes the ones older than the retention setting, and `removeAll` clears
 * out every backup folder under the library — including ones made before this
 * record existed.
 *
 * Where the list is kept is the shell's business: it hands in something that
 * can load and save, and gets back a registry that knows nothing about
 * filesystems or application directories.
 */

import { expiredBackups, type BackupRecord } from '../backups.js'
import type { RepairHost } from '../host.js'
import { BACKUP_DIRECTORY } from './output.js'

/** Where the list of backups is kept, which differs per shell. */
export interface BackupStore {
  load: () => Promise<BackupRecord[]>
  save: (records: BackupRecord[]) => Promise<void>
}

export interface PruneResult {
  removed: number
  bytes: number
}

export interface BackupSummary {
  files: string[]
  bytes: number
}

export interface BackupRegistry {
  record: (entry: BackupRecord) => Promise<void>
  prune: (host: RepairHost, retentionDays: number, now?: number) => Promise<PruneResult>
  removeAll: (roots: string[], host: RepairHost) => Promise<PruneResult>
}

/** Remove a backup file, then its folder if that leaves it empty. */
async function removeBackupFile(path: string, host: RepairHost): Promise<void> {
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

/**
 * Every file in a backup folder under these roots. Folders are walked through
 * the host, so this finds backups the record does not know about too.
 */
export async function findBackups(roots: string[], host: RepairHost, maxDepth = 8): Promise<BackupSummary> {
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

/**
 * The operations that read and write the record.
 *
 * They go one at a time: two repairs finishing together must not each write
 * back a list missing the other's backup.
 */
export function createBackupRegistry(store: BackupStore): BackupRegistry {
  let queue: Promise<unknown> = Promise.resolve()
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  const record = (entry: BackupRecord): Promise<void> =>
    serially(async () => {
      const records = (await store.load()).filter((existing) => existing.path !== entry.path)
      records.push(entry)
      await store.save(records)
    })

  const prune = (host: RepairHost, retentionDays: number, now = Date.now()): Promise<PruneResult> =>
    serially(async () => {
      const records = await store.load()
      const expired = new Set(expiredBackups(records, now, retentionDays, host.label))
      const kept: BackupRecord[] = []
      let removed = 0
      let bytes = 0
      for (const entry of records) {
        if (entry.host !== host.label) {
          kept.push(entry)
          continue
        }
        const info = await host.stat(entry.path)
        if (!info) {
          // Gone from a folder that is still there: removed by hand, so forget
          // it. If the folder is missing too, the drive is probably just not
          // mounted, and the record has to wait for it to come back.
          const folder = host.paths.dirname(host.paths.dirname(entry.path))
          if (!(await host.stat(folder))) kept.push(entry)
          continue
        }
        if (!expired.has(entry)) {
          kept.push(entry)
          continue
        }
        try {
          await removeBackupFile(entry.path, host)
          removed++
          // A clone shares its data with the file, so removing it frees nothing.
          if (!entry.clone) bytes += info.sizeBytes
        } catch (error) {
          console.warn(`Could not remove the backup ${entry.path}`, error)
          kept.push(entry)
        }
      }
      if (kept.length !== records.length) await store.save(kept)
      return { removed, bytes }
    })

  const removeAll = (roots: string[], host: RepairHost): Promise<PruneResult> =>
    serially(async () => {
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
      const records = await store.load()
      const kept = records.filter((entry) => !(entry.host === host.label && gone.has(entry.path)))
      if (kept.length !== records.length) await store.save(kept)
      return { removed, bytes }
    })

  return { record, prune, removeAll }
}
