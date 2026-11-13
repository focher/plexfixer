/**
 * Which repair backups have outlived the retention setting.
 *
 * Backups are full-size copies of every file a repair replaced, so a library
 * of them fills a disk. They are kept for a set number of days — long enough
 * to notice a repair that went wrong — and then removed.
 *
 * Age comes from when the backup was made, recorded at the time. The file's
 * own dates cannot say: moving the original into the backup folder keeps the
 * modification date it has had for years.
 */

export interface BackupRecord {
  /** Where the backup is. */
  path: string
  /** The file it is a backup of. */
  original: string
  /** When the backup was made, in ms since the epoch. */
  createdAt: number
  /** The host it was made on (`Host.label`), so a remote backup is only removed through that host. */
  host: string
  /** True for an instant APFS clone, which shares its data with the file. */
  clone?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Backups on `host` older than `retentionDays`; 0 keeps everything. */
export function expiredBackups(
  records: BackupRecord[],
  now: number,
  retentionDays: number,
  host: string
): BackupRecord[] {
  if (!(retentionDays > 0)) return []
  const cutoff = now - retentionDays * DAY_MS
  return records.filter((record) => record.host === host && record.createdAt <= cutoff)
}

/** The choices offered in Settings. */
export const RETENTION_CHOICES: { days: number; label: string }[] = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 0, label: 'Never' }
]
