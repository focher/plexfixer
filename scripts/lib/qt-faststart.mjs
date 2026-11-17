/**
 * Building `qt-faststart`, the one-pass MP4 index mover, from its own source.
 *
 * PlexFixer bundles ffmpeg, and ffmpeg can move an MP4's index — by remuxing
 * the file and then rewriting the whole thing a second time. `qt-faststart`
 * does the same move in one read and one write, which on a multi-gigabyte file
 * over a share is about half the time. The app uses it when moving the index
 * is the entire repair, and falls back to ffmpeg when it is not there.
 *
 * It is not there in practice. None of the ffmpeg builds PlexFixer downloads
 * ship it — BtbN's Windows archive carries ffmpeg, ffplay and ffprobe and
 * nothing else — so an installed copy of the app never found one, and the
 * whole fast path only ever ran for people who happened to have a Homebrew
 * ffmpeg on PATH.
 *
 * So it is built here. The source is one self-contained C file from FFmpeg's
 * own tree: standard headers only, no library to link, and placed in the
 * public domain by its author, which is why it can be compiled and shipped
 * without touching the licence question the ffmpeg binaries raise.
 *
 * A machine with no C compiler is not an error. The app's behaviour without
 * qt-faststart is the behaviour it has had all along, and failing a build over
 * an optional speed-up would be the wrong trade.
 */

import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The source, pinned.
 *
 * `tools/qt-faststart.c` is byte-identical between n8.1.3 and n9.0.2 — the two
 * FFmpeg releases PlexFixer ships binaries from — so one pin covers every
 * platform. It is checksummed like every other download: this one is compiled
 * and put inside a signed installer, which is the strongest reason of all to
 * know exactly what arrived.
 */
export const SOURCE = {
  url: 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.1.3/tools/qt-faststart.c',
  sha256: '58b446d1d3c18541dc312189bedd7bcd1e22d91bfe78e7ddd0305242db0a61ab',
}

/**
 * Left in a platform folder when the compile could not be done here.
 *
 * Without it every build would try again and warn again on a machine that has
 * no compiler and never will. It starts with a dot, so the checks that ask
 * whether a folder holds binaries ignore it, and `--force` clears it.
 */
export const UNAVAILABLE = '.qt-faststart-unavailable'

/**
 * Which attempt the note refers to.
 *
 * Bumped whenever the way this compiles changes. A note says "it could not be
 * built here", which is only ever true of a particular way of building it —
 * and the first Windows build failed on a quoting bug in the command line, so
 * the note it left was wrong the moment that was fixed. Without a stamp the
 * next build read the note, skipped the attempt, and shipped the note instead
 * of the binary. A note from a different recipe is ignored and the compile is
 * tried again.
 */
export const RECIPE = 2

/** The note's text: the recipe it refers to, then why it failed. */
export function markerText(reason, recipe = RECIPE) {
  return `recipe ${recipe}\n${reason}\n`
}

/** Whether a note still speaks for how this builds today. */
export function markerIsCurrent(text, recipe = RECIPE) {
  const first = String(text ?? '').split('\n', 1)[0]?.trim()
  return first === `recipe ${recipe}`
}

/** Why the last attempt failed, for the caller to report. */
export function markerReason(text) {
  const lines = String(text ?? '')
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() !== '')
  return lines.join('; ') || 'no reason recorded'
}

/**
 * Which platform folders this machine can compile for.
 *
 * A C compiler targets the machine it runs on, with one exception: Apple's
 * clang carries both macOS architectures, so one Mac builds for both. Nothing
 * else cross-compiles without a toolchain nobody has asked to install, and the
 * platform that needs it is built on its own machine anyway.
 */
export function canBuildHere(platformKey, host = process.platform) {
  if (host === 'darwin') return platformKey === 'darwin-arm64' || platformKey === 'darwin-x64'
  if (host === 'win32') return platformKey === 'win32-x64'
  if (host === 'linux') return platformKey === 'linux-x64'
  return false
}

/** The `-arch` a macOS platform folder wants, if it is one. */
export function archFlagFor(platformKey) {
  if (platformKey === 'darwin-arm64') return 'arm64'
  if (platformKey === 'darwin-x64') return 'x86_64'
  return undefined
}

/**
 * The compiler command for a Unix build.
 *
 * `_FILE_OFFSET_BITS=64` because this seeks around files far past 2 GB and the
 * source's own header warns that building it outside FFmpeg's make system is
 * where that goes wrong.
 */
export function unixCompileArgs({ source, output, arch }) {
  return [
    ...(arch ? ['-arch', arch] : []),
    '-O2',
    '-D_FILE_OFFSET_BITS=64',
    '-o',
    output,
    source,
  ]
}

/**
 * The MSVC command line.
 *
 * Bare names, no paths: the compile is run with the work directory as its
 * current directory, where the source already is and where the binary is
 * wanted. That is not tidiness. Quoting a Windows path on a command line a
 * compiler will re-parse is a trap — `cl /Fo"C:\work\"` looks like a quoted
 * directory and is read as an *escaped quote*, because a backslash before a
 * quote escapes it, so the quote never closes and `cl` swallows the rest of
 * the line, source filename and all. That is exactly the "D8003 missing source
 * filename" this used to fail with. A name with no path in it cannot do that.
 *
 * The object file lands in the current directory by default, which is already
 * the work directory, so it needs no flag of its own either.
 */
export function msvcCompileArgs({ source, output }) {
  return ['/nologo', '/O2', `/Fe:${output}`, source]
}

/**
 * The batch file that runs MSVC through `vcvarsall.bat`.
 *
 * Only one path appears in it — Visual Studio's own, which lives under
 * "Program Files (x86)" and so always has a space — and it is quoted, which is
 * safe here because it does not end in a backslash. `cd /d` because
 * `vcvarsall.bat` is entitled to leave the current directory somewhere else,
 * and the compile line depends on being in the work directory.
 */
export function msvcBatchScript({ vcvars, workDir, args }) {
  return [
    '@echo off',
    `call "${vcvars}" x64 || exit /b 1`,
    `cd /d "${workDir}" || exit /b 1`,
    `cl ${args.join(' ')} || exit /b 1`,
    '',
  ].join('\r\n')
}

/**
 * Visual Studio's own locator, at the fixed path its installer uses.
 *
 * The same way cargo finds MSVC. `cl.exe` is not on PATH in an ordinary
 * PowerShell — it is put there by `vcvarsall.bat` — so the batch file is found
 * and the compile is run through it.
 */
async function findVcvars() {
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vswhere = join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return undefined
  try {
    const { stdout } = await execFileAsync(
      vswhere,
      [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ],
      { timeout: 30_000 },
    )
    const installation = stdout.trim().split('\n')[0]?.trim()
    if (!installation) return undefined
    const vcvars = join(installation, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
    return existsSync(vcvars) ? vcvars : undefined
  } catch {
    return undefined
  }
}

/**
 * What a failed compile actually said, in one line.
 *
 * `cl` prints its diagnostics to stdout, not stderr, so an error's `message`
 * alone loses the only part worth reading. Keeping the last few lines is
 * enough to tell a missing compiler from a compiler that ran and objected.
 */
function why(error) {
  const printed = [error?.stdout, error?.stderr]
    .filter(Boolean)
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (printed.length > 0) return printed.slice(-3).join('; ')
  return String(error?.message ?? 'unknown error').split('\n')[0]
}

/**
 * Compile on Windows: MSVC if it is installed, else a MinGW-style compiler.
 *
 * Each candidate is tried by compiling with it rather than by asking whether
 * it is there. `cl /?` and friends disagree about exit codes, and a compiler
 * that answers a probe and then cannot build is a worse failure than one that
 * never answered at all. Every attempt's reason is kept, because "no compiler
 * found" when one is installed and merely unhappy is a maddening thing to be
 * told.
 *
 * Nothing here runs through a shell. The arguments are passed as arguments,
 * which is both what removes a whole class of quoting bugs and what silences
 * Node's own warning about doing otherwise. `cl.exe`, `clang.exe` and
 * `gcc.exe` are all found on PATH without one.
 */
async function compileOnWindows({ source, output, workDir }) {
  const msvc = msvcCompileArgs({ source, output })
  const tried = []

  try {
    await execFileAsync('cl', msvc, { cwd: workDir, timeout: 120_000 })
    return 'cl'
  } catch (error) {
    // Normally just absent: `cl` is put on PATH by vcvarsall, not by login.
    tried.push(`cl: ${why(error)}`)
  }

  const vcvars = await findVcvars()
  if (vcvars) {
    try {
      const script = join(workDir, 'build-qt-faststart.bat')
      await writeFile(script, msvcBatchScript({ vcvars, workDir, args: msvc }))
      await execFileAsync('cmd', ['/c', script], { cwd: workDir, timeout: 180_000 })
      return 'cl (through vcvarsall)'
    } catch (error) {
      tried.push(`cl through vcvarsall: ${why(error)}`)
    }
  } else {
    tried.push('vcvarsall: no Visual Studio with the C++ tools is installed')
  }

  for (const compiler of ['clang', 'gcc']) {
    try {
      await execFileAsync(compiler, unixCompileArgs({ source, output }), {
        cwd: workDir,
        timeout: 120_000,
      })
      return compiler
    } catch (error) {
      tried.push(`${compiler}: ${why(error)}`)
    }
  }

  throw new Error(
    `no C compiler built it (${tried.join(' | ')}). The Visual Studio Build Tools with\n` +
      '    the C++ workload are what cargo already needs to build PlexFixer on Windows;\n' +
      '    clang or gcc also work.',
  )
}

/** Compile on macOS or Linux with whatever `cc` is. */
async function compileOnUnix({ source, output, arch, workDir }) {
  const compilers = [process.env.CC, 'cc', 'clang', 'gcc'].filter(Boolean)
  let lastError
  for (const compiler of compilers) {
    try {
      await execFileAsync(compiler, unixCompileArgs({ source, output, arch }), {
        cwd: workDir,
        timeout: 120_000,
      })
      return compiler
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `no working C compiler (tried ${compilers.join(', ')}): ${lastError ? why(lastError) : 'unknown error'}`,
  )
}

/**
 * Put `qt-faststart` in a platform folder, building it from source.
 *
 * Returns what happened, for the caller to report: `built`, `present` when one
 * is already there, or `skipped` with a reason. Only an unexpected failure
 * throws, and the caller treats even that as non-fatal.
 */
export async function ensureQtFaststart({ platformKey, outputDir, workDir, force = false, download }) {
  const name = platformKey.startsWith('win32') ? 'qt-faststart.exe' : 'qt-faststart'
  const target = join(outputDir, name)
  const marker = join(outputDir, UNAVAILABLE)

  if (!force && existsSync(target)) return { state: 'present', path: target }
  if (force) await rm(marker, { force: true })
  if (!force && existsSync(marker)) {
    const note = await readFile(marker, 'utf8').catch(() => '')
    // A note from an older recipe is not evidence about this one, so it is
    // dropped and the compile tried again.
    if (markerIsCurrent(note)) {
      return {
        state: 'skipped',
        reason: `tried before on this machine — ${markerReason(note)}`,
      }
    }
    await rm(marker, { force: true })
  }

  if (!canBuildHere(platformKey)) {
    await writeFile(marker, markerText(`${platformKey} is not built on ${process.platform}`))
    return {
      state: 'skipped',
      reason: `a C compiler builds for the machine it runs on, and this is ${process.platform}`,
    }
  }

  await mkdir(workDir, { recursive: true })
  const sourceName = 'qt-faststart.c'
  const source = join(workDir, sourceName)

  try {
    await download(SOURCE.url, source, { sha256: SOURCE.sha256 })

    // Read back and checked again here, because this file is about to be
    // compiled and put inside a signed installer.
    const digest = createHash('sha256').update(await readFile(source)).digest('hex')
    if (digest !== SOURCE.sha256) throw new Error(`the source changed after it was fetched (${digest})`)

    // Compiled by name from inside the work directory, never by path: see
    // `msvcCompileArgs` for what a quoted Windows path does to a command line.
    const output = join(workDir, name)
    const compiler =
      process.platform === 'win32'
        ? await compileOnWindows({ source: sourceName, output: name, workDir })
        : await compileOnUnix({
            source: sourceName,
            output: name,
            arch: archFlagFor(platformKey),
            workDir,
          })

    await mkdir(outputDir, { recursive: true })
    await writeFile(target, await readFile(output))
    if (!platformKey.startsWith('win32')) await chmod(target, 0o755)
    await rm(marker, { force: true })
    return { state: 'built', path: target, compiler }
  } catch (error) {
    await mkdir(outputDir, { recursive: true })
    await writeFile(marker, markerText(error.message))
    return { state: 'skipped', reason: error.message }
  }
}
