/**
 * Building the bundled `qt-faststart`.
 *
 * What is worth testing here is the part that decides *whether* and *how* to
 * compile — a wrong answer there either ships nothing on a platform that could
 * have had it, or stops a build over a speed-up that is meant to be optional.
 * The compiling itself is the C compiler's business.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// prettier-ignore
// @ts-expect-error -- plain ESM helper shared with the build scripts
import { SOURCE, UNAVAILABLE, archFlagFor, canBuildHere, ensureQtFaststart, msvcBatchScript, msvcCompileArgs, unixCompileArgs } from '../scripts/lib/qt-faststart.mjs'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-qtbuild-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('canBuildHere', () => {
  it('builds both macOS architectures from one Mac', () => {
    // Apple's clang carries both, which is why `dist.mjs` can build an Intel
    // installer on an Apple Silicon machine at all.
    expect(canBuildHere('darwin-arm64', 'darwin')).toBe(true)
    expect(canBuildHere('darwin-x64', 'darwin')).toBe(true)
  })

  it('does not pretend to cross-compile', () => {
    expect(canBuildHere('win32-x64', 'darwin')).toBe(false)
    expect(canBuildHere('linux-x64', 'darwin')).toBe(false)
    expect(canBuildHere('darwin-arm64', 'win32')).toBe(false)
  })

  it('builds its own platform elsewhere', () => {
    expect(canBuildHere('win32-x64', 'win32')).toBe(true)
    expect(canBuildHere('linux-x64', 'linux')).toBe(true)
    expect(canBuildHere('linux-x64', 'freebsd')).toBe(false)
  })
})

describe('the compiler command', () => {
  it('asks for the architecture only on macOS', () => {
    expect(archFlagFor('darwin-arm64')).toBe('arm64')
    expect(archFlagFor('darwin-x64')).toBe('x86_64')
    expect(archFlagFor('linux-x64')).toBeUndefined()
  })

  it('builds with 64-bit file offsets', () => {
    // It seeks around files far past 2 GB, and the source's own header warns
    // that building it outside FFmpeg's make system is where that goes wrong.
    const args = unixCompileArgs({ source: 'q.c', output: 'q', arch: 'arm64' })
    expect(args).toContain('-D_FILE_OFFSET_BITS=64')
    expect(args.join(' ')).toContain('-arch arm64')
    expect(args[args.length - 1]).toBe('q.c')
  })

  it('gives MSVC bare names, never a path', () => {
    // `cl /Fo"C:\work\"` is not a quoted directory: the backslash escapes the
    // quote, the quote never closes, and cl swallows the source filename that
    // follows — "D8003 missing source filename". Running from the work
    // directory means no argument has a path in it at all.
    const args = msvcCompileArgs({ source: 'qt-faststart.c', output: 'qt-faststart.exe' })
    expect(args).toEqual(['/nologo', '/O2', '/Fe:qt-faststart.exe', 'qt-faststart.c'])
    for (const arg of args) {
      expect(arg).not.toContain('"')
      expect(arg).not.toContain('\\')
    }
  })
})

describe('the MSVC batch file', () => {
  const script = (): string =>
    msvcBatchScript({
      vcvars: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat',
      workDir: 'C:\\Users\\Someone\\AppData\\Local\\Temp\\plexfixer-ffmpeg-abc\\qt-faststart',
      args: msvcCompileArgs({ source: 'qt-faststart.c', output: 'qt-faststart.exe' })
    })

  it('quotes the one path it has, which always has a space in it', () => {
    expect(script()).toContain('call "C:\\Program Files (x86)\\Microsoft Visual Studio')
  })

  it('never ends a quoted argument with a backslash', () => {
    // The whole failure mode, caught at the line level: a quote preceded by a
    // backslash is an escaped quote, not a closing one.
    for (const line of script().split('\r\n')) expect(line).not.toContain('\\"')
  })

  it('returns to the work directory, which vcvarsall may have left', () => {
    const lines = script().split('\r\n')
    const toVcvars = lines.findIndex((line) => line.startsWith('call '))
    const back = lines.findIndex((line) => line.startsWith('cd /d '))
    const compile = lines.findIndex((line) => line.startsWith('cl '))
    expect(toVcvars).toBeGreaterThanOrEqual(0)
    expect(back).toBeGreaterThan(toVcvars)
    expect(compile).toBeGreaterThan(back)
  })

  it('stops at the first step that fails', () => {
    for (const line of script().split('\r\n').slice(1).filter(Boolean)) {
      expect(line).toMatch(/\|\| exit \/b 1$/)
    }
  })

  it('compiles the source last, where cl expects it', () => {
    const compile = script().split('\r\n').find((line) => line.startsWith('cl '))
    expect(compile).toBe('cl /nologo /O2 /Fe:qt-faststart.exe qt-faststart.c || exit /b 1')
  })
})

describe('ensureQtFaststart', () => {
  const never = async (): Promise<never> => {
    throw new Error('should not have been downloaded')
  }

  it('leaves one that is already there alone', async () => {
    await writeFile(join(dir, 'qt-faststart'), 'binary')
    const result = await ensureQtFaststart({
      platformKey: 'darwin-arm64',
      outputDir: dir,
      workDir: join(dir, 'work'),
      download: never
    })
    expect(result.state).toBe('present')
  })

  it('notes a platform it cannot build for, and does not ask again', async () => {
    const options = {
      platformKey: 'win32-x64',
      outputDir: dir,
      workDir: join(dir, 'work'),
      download: never
    }
    const first = await ensureQtFaststart({ ...options })
    expect(first.state).toBe('skipped')
    expect(existsSync(join(dir, UNAVAILABLE))).toBe(true)

    // Second time it does not even work out why — the note is enough, which is
    // what keeps a machine with no compiler from warning on every build.
    const second = await ensureQtFaststart({ ...options })
    expect(second.reason).toMatch(/tried before/)
  })

  it('reports a download that fails rather than throwing', async () => {
    // An optional speed-up must never fail a fetch that otherwise worked.
    const result = await ensureQtFaststart({
      platformKey: process.platform === 'win32' ? 'win32-x64' : process.platform === 'linux' ? 'linux-x64' : 'darwin-arm64',
      outputDir: dir,
      workDir: join(dir, 'work'),
      download: async () => {
        throw new Error('404 for qt-faststart.c')
      }
    })
    expect(result.state).toBe('skipped')
    expect(result.reason).toMatch(/404/)
    expect(await readFile(join(dir, UNAVAILABLE), 'utf8')).toMatch(/404/)
  })

  it('pins the source to a tag and a checksum', () => {
    expect(SOURCE.url).toMatch(/FFmpeg\/FFmpeg\/n\d+\.\d+\.\d+\/tools\/qt-faststart\.c$/)
    expect(SOURCE.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
