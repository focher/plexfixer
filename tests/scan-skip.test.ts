/**
 * Not reading a file that has not changed.
 *
 * A probe spawns ffprobe and reads the file's headers; on a share that is a
 * round trip per file and the slowest part of a re-scan. The library already
 * knows what it saw last time, so the scan asks the cheap question first —
 * size and modification time — and only reads the file when the answer differs.
 *
 * The trap this guards: a file that is skipped must still be *found*. A scan
 * drops library entries it no longer sees, so a skipped file missing from the
 * list of what was found would be deleted from the library for the crime of
 * not having changed.
 */

import { describe, expect, it } from 'vitest'
import { isUnchanged, runScan, type KnownFile } from '@shared/plex/scan.js'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import type { HostStat, ProbeHost } from '../src/shared/host.js'

const POSIX = {
  sep: '/',
  join: (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/'),
  dirname: (path: string): string => path.replace(/\/[^/]*$/, '') || '/',
  basename: (path: string): string => path.split('/').pop() ?? '',
  extname: (path: string): string => {
    const dot = (path.split('/').pop() ?? '').lastIndexOf('.')
    return dot > 0 ? (path.split('/').pop() ?? '').slice(dot) : ''
  },
  isAbsolute: (path: string): boolean => path.startsWith('/')
}

interface OnDisk {
  sizeBytes: number
  modifiedMs: number
}

/**
 * A host where ffprobe always fails.
 *
 * Which makes "was this file read?" easy to see from the outside: a probed
 * file leaves an error behind and a skipped one leaves nothing. Building
 * believable ffprobe output would prove less.
 */
function host(disk: Record<string, OnDisk>, folders: string[] = ['/media']): ProbeHost & { probed: string[] } {
  const probed: string[] = []
  return {
    kind: 'local',
    label: 'this machine',
    paths: POSIX as ProbeHost['paths'],
    probed,
    async stat(path: string): Promise<HostStat | undefined> {
      if (folders.includes(path)) return { isDirectory: true, sizeBytes: 0, modifiedMs: 0 }
      const entry = disk[path]
      return entry ? { isDirectory: false, ...entry } : undefined
    },
    async exec(_binary: string, args: string[]): Promise<string> {
      probed.push(args[args.length - 1])
      throw new Error('not probed in this test')
    }
  } as unknown as ProbeHost & { probed: string[] }
}

async function scan(
  disk: Record<string, OnDisk>,
  known: Map<string, KnownFile>
): Promise<{ probed: string[]; errors: string[]; found: string[] }> {
  const files = Object.keys(disk)
  const machine = host(disk)
  const complete = await runScan({
    scanId: 's1',
    inputPaths: ['/media'],
    settings: { ...DEFAULT_SETTINGS, concurrency: 1 },
    host: machine,
    ffprobePath: '/usr/bin/ffprobe',
    findMedia: async () => files,
    known,
    signal: new AbortController().signal,
    onProgress: () => undefined
  })
  return {
    probed: machine.probed,
    errors: complete.errors.map((error) => error.path),
    found: complete.foundPaths
  }
}

const file = (sizeBytes: number, modifiedMs: number): OnDisk => ({ sizeBytes, modifiedMs })

describe('deciding whether a file needs reading', () => {
  it('is unchanged when the size and the time both match', () => {
    expect(isUnchanged({ sizeBytes: 10, modifiedMs: 5 }, { sizeBytes: 10, modifiedMs: 5 })).toBe(true)
  })

  it('is changed when either differs', () => {
    expect(isUnchanged({ sizeBytes: 10, modifiedMs: 5 }, { sizeBytes: 11, modifiedMs: 5 })).toBe(false)
    expect(isUnchanged({ sizeBytes: 10, modifiedMs: 5 }, { sizeBytes: 10, modifiedMs: 6 })).toBe(false)
  })

  it('will not vouch for an entry stored before times were recorded', () => {
    // Trusting a size on its own would skip a file that was re-encoded to
    // within a byte of its old length, which is exactly what a repair does.
    expect(isUnchanged({ sizeBytes: 10 }, { sizeBytes: 10, modifiedMs: 5 })).toBe(false)
    expect(isUnchanged({ sizeBytes: 10, modifiedMs: 5 }, { sizeBytes: 10 })).toBe(false)
  })

  it('will not vouch when neither side knows the time', () => {
    // The case the guard is really for. Comparing the two times would find
    // them equal — both missing — and fall through to deciding on size alone,
    // which is the one thing it must never do.
    expect(isUnchanged({ sizeBytes: 10 }, { sizeBytes: 10 })).toBe(false)
  })

  it('will not vouch for a file that is no longer there', () => {
    expect(isUnchanged({ sizeBytes: 10, modifiedMs: 5 }, undefined)).toBe(false)
    expect(isUnchanged(undefined, { sizeBytes: 10, modifiedMs: 5 })).toBe(false)
  })
})

describe('re-scanning a library', () => {
  const disk = {
    '/media/same.mkv': file(100, 1000),
    '/media/resized.mkv': file(200, 1000),
    '/media/touched.mkv': file(100, 2000),
    '/media/new.mkv': file(100, 1000)
  }
  const known = new Map<string, KnownFile>([
    ['/media/same.mkv', { sizeBytes: 100, modifiedMs: 1000 }],
    ['/media/resized.mkv', { sizeBytes: 100, modifiedMs: 1000 }],
    ['/media/touched.mkv', { sizeBytes: 100, modifiedMs: 1000 }]
  ])

  it('reads only the files that changed, and the ones it has never seen', async () => {
    const { probed } = await scan(disk, known)
    expect(probed.sort()).toEqual(['/media/new.mkv', '/media/resized.mkv', '/media/touched.mkv'])
    expect(probed).not.toContain('/media/same.mkv')
  })

  it('still counts the untouched file as found, so it is not dropped from the library', async () => {
    const { found } = await scan(disk, known)
    expect(found).toContain('/media/same.mkv')
  })

  it('leaves no error behind for a file it did not read', async () => {
    const { errors } = await scan(disk, known)
    expect(errors).not.toContain('/media/same.mkv')
  })

  it('reads everything when the library is empty, as it always did', async () => {
    const { probed } = await scan(disk, new Map())
    expect(probed.sort()).toEqual([
      '/media/new.mkv',
      '/media/resized.mkv',
      '/media/same.mkv',
      '/media/touched.mkv'
    ])
  })

  it('reads a file the library knows but the disk no longer describes', async () => {
    // `stat` returning nothing means something is odd; read it rather than
    // assume it is the file that was there before.
    const machine = host({}, [])
    const complete = await runScan({
      scanId: 's1',
      inputPaths: ['/media'],
      settings: { ...DEFAULT_SETTINGS, concurrency: 1 },
      host: machine,
      ffprobePath: '/usr/bin/ffprobe',
      findMedia: async () => ['/media/ghost.mkv'],
      known: new Map([['/media/ghost.mkv', { sizeBytes: 100, modifiedMs: 1000 }]]),
      signal: new AbortController().signal,
      onProgress: () => undefined
    })
    expect(machine.probed).toEqual(['/media/ghost.mkv'])
    expect(complete.errors).toHaveLength(1)
  })
})
