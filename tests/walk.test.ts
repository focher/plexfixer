/**
 * The scanner's job is to find every media file under the folders it is given.
 * These lock in the two ways that quietly stops happening: nested folders being
 * missed, and entries whose type the directory listing does not report.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectMediaFiles } from '../src/main/scan/walk.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-walk-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const options = { extensions: ['mkv', 'mp4', 'm4v'], recursive: true }

async function touch(...parts: string[]): Promise<string> {
  const full = join(dir, ...parts)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, '')
  return full
}

describe('collectMediaFiles', () => {
  it('descends through nested folders', async () => {
    const top = await touch('top.mkv')
    const movie = await touch('Movies', 'Example (2020)', 'Example (2020).mkv')
    const episode = await touch('TV', 'Show', 'Season 01', 'S01E01.mp4')

    expect(await collectMediaFiles([dir], options)).toEqual([movie, episode, top].sort((a, b) => a.localeCompare(b)))
  })

  it('stays in the top folder when recursion is off', async () => {
    const top = await touch('top.mkv')
    await touch('Movies', 'Example (2020)', 'Example (2020).mkv')

    expect(await collectMediaFiles([dir], { ...options, recursive: false })).toEqual([top])
  })

  it('ignores non-media extensions and skipped folders', async () => {
    const keep = await touch('Movies', 'Example (2020)', 'Example (2020).mkv')
    await touch('Movies', 'Example (2020)', 'Example (2020).nfo')
    await touch('Movies', '.plexfixer-backups', 'Example (2020).mkv')
    await touch('Movies', '@eaDir', 'Example (2020).mkv')

    expect(await collectMediaFiles([dir], options)).toEqual([keep])
  })

  it('does not follow symlinked folders, so a cross-linked library is not counted twice', async () => {
    const real = await touch('Anime', 'Series A', 'ep1.mkv')
    await symlink(join(dir, 'Anime'), join(dir, 'AnimeLink'))

    expect(await collectMediaFiles([dir], options)).toEqual([real])
  })

  it('follows a symlink given explicitly as an input path', async () => {
    const real = await touch('Anime', 'Series A', 'ep1.mkv')
    await symlink(join(dir, 'Anime'), join(dir, 'AnimeLink'))

    expect(await collectMediaFiles([join(dir, 'AnimeLink')], options)).toEqual([
      join(dir, 'AnimeLink', 'Series A', 'ep1.mkv')
    ])
    expect(real).toContain('ep1.mkv')
  })

  it('survives entries that are neither a file nor a folder', async () => {
    // The lstat fallback that rescues unknown-type entries on SMB and NFS runs
    // for anything the directory listing does not classify; a FIFO is the one
    // such entry a local filesystem can produce, and it must be ignored rather
    // than crash the walk.
    const movie = await touch('Movies', 'Example (2020)', 'Example (2020).mkv')
    execFileSync('mkfifo', [join(dir, 'Movies', 'pipe')])

    expect(await collectMediaFiles([dir], options)).toEqual([movie])
  })
})
