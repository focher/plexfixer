/**
 * Instant APFS-clone backups: the mount-table parsing that decides when a
 * clone is possible, and a real header edit that keeps one. The edit uses real
 * ffmpeg and ffprobe, and is skipped when they are not installed.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import type { BackupRecord } from '@shared/backups.js'
import type { Job } from '@shared/types.js'
import { probeFile } from '../src/main/ffmpeg/probe.js'
import { RepairRunner } from '../src/main/jobs/runner.js'
import { localHost } from '../src/main/host.js'
import { parseMountTypes } from '../src/main/volumes.js'

const execFileAsync = promisify(execFile)

function find(binary: string): string | undefined {
  for (const dir of [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (dir && existsSync(join(dir, binary))) return join(dir, binary)
  }
  return undefined
}

const FFMPEG = find('ffmpeg')
const FFPROBE = find('ffprobe')
const enabled = Boolean(FFMPEG && FFPROBE)

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-clone-'))
})
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function repair(path: string, ffmpegPath: string): Promise<{ job: Job; backups: BackupRecord[] }> {
  const probed = await probeFile(path, { ffprobePath: FFPROBE! })
  const result = analyzeFile(probed, DEFAULT_SETTINGS)
  const backups: BackupRecord[] = []
  let finished: Job | undefined
  const runner = new RepairRunner({ ffmpegPath, ffprobePath: FFPROBE! }, 1, (job) => {
    if (job.state === 'done' || job.state === 'failed' || job.state === 'skipped') finished = job
  })
  runner.onBackup = (record) => backups.push(record)
  runner.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
  for (let waited = 0; !finished && waited < 15_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!finished) {
    const last = runner.list()[0]
    throw new Error(`the repair did not finish: ${last?.state} / ${last?.stage}\n${last?.log.map((entry) => entry.text).join('\n')}`)
  }
  return { job: finished, backups }
}

describe('instant clones', () => {
  it('reads filesystem types from macOS mount output', () => {
    const types = parseMountTypes(
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n' +
        '/dev/disk15s1 on /Volumes/Video10e (apfs, local, nodev, nosuid, journaled, noowners)\n' +
        '//guest@nas/Media on /Volumes/Media (smbfs, nodev, nosuid, mounted by me)\n' +
        '/dev/disk9s1 on /Volumes/My Card (exfat, local, nodev, nosuid, noowners)'
    )
    expect(types.get('/')).toBe('apfs')
    expect(types.get('/Volumes/Video10e')).toBe('apfs')
    expect(types.get('/Volumes/Media')).toBe('smbfs')
    expect(types.get('/Volumes/My Card')).toBe('exfat')
  })

  it.skipIf(!enabled || process.platform !== 'darwin')(
    'keeps an instant clone before editing a header in place',
    { timeout: 60_000 },
    async () => {
      // Index already at the front and an untagged audio track: the repair is
      // a language tag, written straight into the header.
      const path = join(dir, 'header-edit.mp4')
      await execFileAsync(FFMPEG!, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
        '-f', 'lavfi', '-i', 'sine=duration=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-metadata:s:v:0', 'language=eng', '-movflags', '+faststart',
        '-y', path
      ])
      const before = await readFile(path)
      const { job, backups } = await repair(path, FFMPEG!)

      expect(job.state).toBe('done')
      expect(job.message).toContain('edited in place')
      expect(job.log.some((entry) => entry.text === 'Instant backup (APFS clone)')).toBe(true)
      expect(backups).toHaveLength(1)
      expect(backups[0]?.clone).toBe(true)
      // The backup is the file as it was; the file itself has changed.
      expect(await readFile(backups[0]!.path)).toEqual(before)
      expect(await readFile(path)).not.toEqual(before)
    }
  )

  it.skipIf(process.platform !== 'darwin')('clones a file on an APFS volume', async () => {
    const source = join(dir, 'clone-source.bin')
    await writeFile(source, Buffer.alloc(1024 * 1024, 7))
    const target = join(dir, 'clone-target.bin')
    expect(await localHost().cloneFile(source, target)).toBe(true)
    expect(await readFile(target)).toEqual(await readFile(source))
  })
})
