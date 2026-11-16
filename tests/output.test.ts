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
  PromoteError,
  discardTemporary,
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

  it('leaves an unrelated file at the destination exactly where it is', async () => {
    // Repairing Movie.mkv targets Movie.mp4 — which may already exist as a
    // different file. Replacing the original was asked for; this one was not.
    // It used to be moved into the backup folder, where it expired a week
    // later, and with backups off it was simply deleted.
    const source = join(dir, 'Movie.mkv')
    const output = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL MKV')
    await writeFile(output, 'PRE-EXISTING MP4')
    await writeFile(temporary, 'REPAIRED')

    const { finalPath } = await promoteOutput(temporary, output, source, settings(), localHost())

    expect(finalPath).toBe(join(dir, 'Movie (2).mp4'))
    expect(await readFile(output, 'utf8')).toBe('PRE-EXISTING MP4')
    expect(await readFile(finalPath, 'utf8')).toBe('REPAIRED')
    expect(await readdir(join(dir, BACKUP_DIRECTORY))).toEqual(['Movie.mkv'])
  })

  it('leaves that file alone with backups off too', async () => {
    const source = join(dir, 'Movie.mkv')
    const output = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL MKV')
    await writeFile(output, 'PRE-EXISTING MP4')
    await writeFile(temporary, 'REPAIRED')

    const { finalPath } = await promoteOutput(temporary, output, source, settings({ keepBackups: false }), localHost())

    expect(await readFile(output, 'utf8')).toBe('PRE-EXISTING MP4')
    expect(await readFile(finalPath, 'utf8')).toBe('REPAIRED')
    expect((await readdir(dir)).sort()).toEqual(['Movie (2).mp4', 'Movie.mp4'])
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

  it('replaces a file under its own name in one step when backups are off', async () => {
    const source = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL')
    await writeFile(temporary, 'REPAIRED')

    const { finalPath } = await promoteOutput(temporary, source, source, settings({ keepBackups: false }), localHost())

    expect(finalPath).toBe(source)
    expect(await readFile(source, 'utf8')).toBe('REPAIRED')
    expect(await readdir(dir)).toEqual(['Movie.mp4'])
  })
})

/**
 * The move that puts the repaired file in place, failing.
 *
 * A destination held open by a player or a scanner, a share that drops: this
 * is the step that goes wrong in practice, and it used to come *after* the
 * original had been moved or deleted. The caller then discarded the temporary
 * — exactly as `runner.execute` does — and with backups off nothing was left.
 */
describe('promoteOutput — when the final move fails', () => {
  /** A host whose rename fails for one source path and works for the rest. */
  function failingMoveOf(path: string): ReturnType<typeof localHost> {
    const real = localHost()
    return {
      ...real,
      rename: async (from: string, to: string) => {
        if (from === path) throw new Error('EBUSY: resource busy or locked')
        return real.rename(from, to)
      }
    }
  }

  it('keeps the original when backups are off and the container changes', async () => {
    const source = join(dir, 'Movie.mkv')
    const output = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL')
    await writeFile(temporary, 'REPAIRED')
    const host = failingMoveOf(temporary)

    await expect(promoteOutput(temporary, output, source, settings({ keepBackups: false }), host)).rejects.toThrow(/EBUSY/)
    await discardTemporary(temporary, host)

    expect(await readFile(source, 'utf8')).toBe('ORIGINAL')
    expect(await readdir(dir)).toEqual(['Movie.mkv'])
  })

  it('keeps the original when backups are off and the name stays the same', async () => {
    const source = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL')
    await writeFile(temporary, 'REPAIRED')
    const host = failingMoveOf(temporary)

    await expect(promoteOutput(temporary, source, source, settings({ keepBackups: false }), host)).rejects.toThrow(/EBUSY/)

    expect(await readFile(source, 'utf8')).toBe('ORIGINAL')
  })

  it('puts the original back when it had already been moved to the backup folder', async () => {
    const source = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL')
    await writeFile(temporary, 'REPAIRED')
    const host = failingMoveOf(temporary)

    const failure = await promoteOutput(temporary, source, source, settings(), host).catch((error: unknown) => error)

    // An ordinary error, not a PromoteError: the disk is as it was found, so
    // the caller is right to discard the temporary and say nothing changed.
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(PromoteError)
    expect(await readFile(source, 'utf8')).toBe('ORIGINAL')
    expect((await readdir(dir)).sort()).toEqual(['.tmp-Movie.mp4', 'Movie.mp4'])
  })

  it('says where both files are when the original cannot be put back either', async () => {
    const source = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL')
    await writeFile(temporary, 'REPAIRED')
    const real = localHost()
    // The move into the backup folder works; everything after it fails.
    let moves = 0
    const host = {
      ...real,
      rename: async (from: string, to: string) => {
        if (moves++ > 0) throw new Error('EIO: the share went away')
        return real.rename(from, to)
      }
    }

    const failure = await promoteOutput(temporary, source, source, settings(), host).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PromoteError)
    const stranded = failure as PromoteError
    // Neither file is gone, and the error carries where each one is — which
    // is what stops the caller tidying the repaired copy away.
    expect(await readFile(stranded.backupPath, 'utf8')).toBe('ORIGINAL')
    expect(await readFile(stranded.temporaryPath, 'utf8')).toBe('REPAIRED')
    expect(stranded.message).toContain(stranded.backupPath)
  })

  it('reports rather than fails when only the original could not be cleared away', async () => {
    const source = join(dir, 'Movie.mkv')
    const output = join(dir, 'Movie.mp4')
    const temporary = join(dir, '.tmp-Movie.mp4')
    await writeFile(source, 'ORIGINAL')
    await writeFile(temporary, 'REPAIRED')
    const real = localHost()
    const host = { ...real, remove: async () => Promise.reject(new Error('EPERM: read-only')) }

    const promoted = await promoteOutput(temporary, output, source, settings({ keepBackups: false }), host)

    expect(promoted.finalPath).toBe(output)
    expect(promoted.originalLeft).toMatch(/EPERM/)
    expect(await readFile(output, 'utf8')).toBe('REPAIRED')
    expect(await readFile(source, 'utf8')).toBe('ORIGINAL')
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
