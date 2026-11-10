/**
 * SMB, NFS and several FUSE mounts — where a Plex library usually lives —
 * return every directory entry as an unknown type, so `isDirectory()` and
 * `isFile()` are both false. A walker that trusts the directory entry alone
 * then finds nothing at all. This file reproduces that filesystem by masking
 * the types off every entry readdir returns.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const entries = await (actual.readdir as (...a: unknown[]) => Promise<unknown[]>)(...args)
      return entries.map((entry) =>
        typeof entry === 'string'
          ? entry
          : Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, {
              isDirectory: () => false,
              isFile: () => false,
              isSymbolicLink: () => false,
              isBlockDevice: () => false,
              isCharacterDevice: () => false,
              isFIFO: () => false,
              isSocket: () => false
            })
      )
    }
  }
})

const { collectMediaFiles } = await import('../src/main/scan/walk.js')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-unknown-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('collectMediaFiles on a filesystem that does not report entry types', () => {
  it('still finds media in nested folders', async () => {
    await mkdir(join(dir, 'Movies', 'Example (2020)'), { recursive: true })
    await mkdir(join(dir, 'TV', 'Show', 'Season 01'), { recursive: true })
    const movie = join(dir, 'Movies', 'Example (2020)', 'Example (2020).mkv')
    const episode = join(dir, 'TV', 'Show', 'Season 01', 'S01E01.mp4')
    await writeFile(movie, '')
    await writeFile(episode, '')
    await writeFile(join(dir, 'Movies', 'Example (2020)', 'Example (2020).nfo'), '')

    const found = await collectMediaFiles([dir], { extensions: ['mkv', 'mp4'], recursive: true })
    expect(found).toEqual([movie, episode].sort((a, b) => a.localeCompare(b)))
  })
})
