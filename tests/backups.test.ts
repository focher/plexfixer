import { describe, expect, it } from 'vitest'
import { expiredBackups, type BackupRecord } from '@shared/backups.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 13)

const record = (daysOld: number, host = 'this machine'): BackupRecord => ({
  path: `/lib/.plexfixer-backups/${daysOld}.m4v`,
  original: `/lib/${daysOld}.m4v`,
  createdAt: NOW - daysOld * DAY,
  host
})

describe('expiredBackups', () => {
  const records = [record(0), record(6), record(7), record(30)]

  it('removes what is at least as old as the retention period', () => {
    expect(expiredBackups(records, NOW, 7, 'this machine').map((entry) => entry.path)).toEqual([
      '/lib/.plexfixer-backups/7.m4v',
      '/lib/.plexfixer-backups/30.m4v'
    ])
  })

  it('keeps everything when set to Never', () => {
    expect(expiredBackups(records, NOW, 0, 'this machine')).toEqual([])
  })

  it('leaves another host’s backups for that host to remove', () => {
    expect(expiredBackups([record(30, 'plex@nas')], NOW, 7, 'this machine')).toEqual([])
    expect(expiredBackups([record(30, 'plex@nas')], NOW, 7, 'plex@nas')).toHaveLength(1)
  })
})
