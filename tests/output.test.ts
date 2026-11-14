/**
 * In-place output is the default, so these cover the one thing that must never
 * happen: losing a file the user did not ask to have replaced.
 */

import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localHost } from './node-host.js'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import {
  BACKUP_DIRECTORY,
  promoteOutput,
  redirectOutput,
  resolveOutputPath
} from '@shared/plex/output.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-out-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const settings = (patch = {}) => ({ ...DEFAULT_SETTINGS, ...patch })

describe('resolveOutputPath', () => {
  it('defaults to replacing the original', () => {
    expect(DEFAULT_SETTINGS.outputPlacement).toBe('in-place')
    expect(resolveOutputPath('/m/Movie.mkv', 'mp4', settings(), localHost())).toBe('/m/Movie.mp4')
    expect(resolveOutputPath('/m/Movie.mp4', 'mp4', settings(), localHost())).toBe('/m/Movie.mp4')
  })
})

describe('promoteOutput — in place', () => {
  it('replaces the original and keeps it in the backup folder', async () => {
    const source = join(dir, 'Movie.mkv')
    const output = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL')
    await writeFile(temporary, 'REPAIRED')

    const { finalPath, backupPath } = await promoteOutput(temporary, output, source, settings(), localHost())

    expect(finalPath).toBe(output)
    expect(await readFile(output, 'utf8')).toBe('REPAIRED')
    expect(backupPath).toBeDefined()
    expect(await readFile(backupPath!, 'utf8')).toBe('ORIGINAL')
    expect(await readdir(dir)).not.toContain('Movie.mkv')
  })

  it('does not destroy an unrelated file already at the destination', async () => {
    // Repairing Movie.mkv targets Movie.mp4 — which may already exist as a
    // different file. Replacing the original was asked for; this one was not.
    const source = join(dir, 'Movie.mkv')
    const output = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL MKV')
    await writeFile(output, 'PRE-EXISTING MP4')
    await writeFile(temporary, 'REPAIRED')

    await promoteOutput(temporary, output, source, settings(), localHost())

    expect(await readFile(output, 'utf8')).toBe('REPAIRED')
    const backups = await readdir(join(dir, BACKUP_DIRECTORY))
    expect(backups.sort()).toEqual(['Movie.mkv', 'Movie.mp4'])
    expect(await readFile(join(dir, BACKUP_DIRECTORY, 'Movie.mp4'), 'utf8')).toBe('PRE-EXISTING MP4')
  })

  it('deletes rather than keeps when backups are turned off', async () => {
    const source = join(dir, 'Movie.mkv')
    const output = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL')
    await writeFile(temporary, 'REPAIRED')

    const { backupPath } = await promoteOutput(temporary, output, source, settings({ keepBackups: false }), localHost())

    expect(backupPath).toBeUndefined()
    expect(await readdir(dir)).toEqual(['Movie.mp4'])
  })
})

describe('promoteOutput — sibling', () => {
  it('leaves the original alone and never overwrites', async () => {
    const source = join(dir, 'Movie.mkv')
    const output = join(dir, 'Movie.plexfixed.mp4')
    const temporary = join(dir, '.tmp.mp4')
    await writeFile(source, 'ORIGINAL')
    await writeFile(output, 'SOMETHING ELSE')
    await writeFile(temporary, 'REPAIRED')

    const { finalPath } = await promoteOutput(temporary, output, source, settings({ outputPlacement: 'sibling' }), localHost())

    expect(finalPath).not.toBe(output)
    expect(await readFile(output, 'utf8')).toBe('SOMETHING ELSE')
    expect(await readFile(source, 'utf8')).toBe('ORIGINAL')
    expect(await readFile(finalPath, 'utf8')).toBe('REPAIRED')
  })
})

describe('resolveOutputPath — extensions', () => {
  it('keeps .m4v, which is already an MP4 container', () => {
    expect(resolveOutputPath('/m/Episode.m4v', 'mp4', settings(), localHost())).toBe('/m/Episode.m4v')
  })

  it('keeps an upper-case extension as the user spelled it', () => {
    expect(resolveOutputPath('/m/Episode.M4V', 'mp4', settings(), localHost())).toBe('/m/Episode.M4V')
  })

  it('still changes the extension when the container really changes', () => {
    expect(resolveOutputPath('/m/Episode.mkv', 'mp4', settings(), localHost())).toBe('/m/Episode.mp4')
    expect(resolveOutputPath('/m/Episode.m4v', 'mkv', settings(), localHost())).toBe('/m/Episode.mkv')
  })
})

describe('redirectOutput', () => {
  // The repair runs into a scratch file and is promoted over the original
  // only once it has been re-probed. Redirecting it must not disturb the
  // input, and when a file is repaired back over itself the two are the
  // same string.
  const scratch = '/m/.plexfixer-1-Episode.mp4'

  it('redirects only the output when the input is the same file', () => {
    const args = ['-i', '/m/Episode.mp4', '-c:v', 'copy', '-y', '/m/Episode.mp4']
    expect(redirectOutput(args, '/m/Episode.mp4', scratch)).toEqual([
      '-i',
      '/m/Episode.mp4',
      '-c:v',
      'copy',
      '-y',
      scratch
    ])
  })

  it('redirects the output when it differs from the input', () => {
    const args = ['-i', '/m/Episode.mkv', '-y', '/m/Episode.mp4']
    expect(redirectOutput(args, '/m/Episode.mp4', scratch)).toEqual(['-i', '/m/Episode.mkv', '-y', scratch])
  })

  it('leaves the arguments alone when the output is not among them', () => {
    const args = ['-i', '/m/Episode.mkv', '-y', '/m/Other.mp4']
    expect(redirectOutput(args, '/m/Episode.mp4', scratch)).toEqual(args)
  })
})
