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
 * The MSVC command line, as text for a batch file.
 *
 * Every path is quoted: these run under `cmd`, and the one path that is always
 * involved — Visual Studio's, under "Program Files (x86)" — has a space in it.
 * `/Fo` keeps the object file in the work directory rather than dropping it
 * beside the binary being built.
 */
export function msvcCompileArgs({ source, output, objectDir }) {
  return ['/nologo', '/O2', `/Fo"${objectDir}\\"`, `/Fe:"${output}"`, `"${source}"`]
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
 * Compile on Windows: MSVC if it is installed, else a MinGW-style compiler.
 *
 * Each candidate is tried by compiling with it rather than by asking whether
 * it is there. `cl /?` and friends disagree about exit codes, and a compiler
 * that answers a probe and then cannot build is a worse failure than one that
 * never answered at all.
 *
 * The MSVC-through-vcvars case goes into a batch file rather than onto a
 * `cmd /c` command line. Quoting a command that itself contains quoted paths,
 * through Node's argument handling and then cmd's, is a well-known way to
 * produce something that works until a path has a space in it — and the path
 * that is always involved is "Program Files (x86)".
 */
async function compileOnWindows({ source, output, workDir }) {
  const msvc = msvcCompileArgs({ source, output, objectDir: workDir })

  try {
    await execFileAsync('cl', msvc, { cwd: workDir, timeout: 120_000, shell: true })
    return 'cl'
  } catch {
    /* Not on PATH, which is the normal state of an ordinary shell. */
  }

  const vcvars = await findVcvars()
  if (vcvars) {
    const script = join(workDir, 'build-qt-faststart.bat')
    await writeFile(
      script,
      [
        '@echo off',
        `call "${vcvars}" x64 >nul || exit /b 1`,
        `cl ${msvc.join(' ')} || exit /b 1`,
        '',
      ].join('\r\n'),
    )
    await execFileAsync('cmd', ['/c', script], { cwd: workDir, timeout: 180_000 })
    return 'cl (through vcvarsall)'
  }

  for (const compiler of ['clang', 'gcc']) {
    try {
      await execFileAsync(compiler, unixCompileArgs({ source, output }), {
        cwd: workDir,
        timeout: 120_000,
        shell: true,
      })
      return compiler
    } catch {
      /* Try the next one. */
    }
  }

  throw new Error(
    'no C compiler found. The Visual Studio Build Tools with the C++ workload are\n' +
      '    what cargo already needs to build PlexFixer on Windows; clang or gcc also work.',
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
    `no working C compiler (tried ${compilers.join(', ')}): ${lastError?.message ?? 'unknown error'}`,
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
  if (!force && existsSync(marker)) return { state: 'skipped', reason: 'tried before on this machine' }

  if (!canBuildHere(platformKey)) {
    await writeFile(marker, `${platformKey} is not built on ${process.platform}\n`)
    return {
      state: 'skipped',
      reason: `a C compiler builds for the machine it runs on, and this is ${process.platform}`,
    }
  }

  await mkdir(workDir, { recursive: true })
  const source = join(workDir, 'qt-faststart.c')

  try {
    await download(SOURCE.url, source, { sha256: SOURCE.sha256 })

    // Read back and checked again here, because this file is about to be
    // compiled and put inside a signed installer.
    const digest = createHash('sha256').update(await readFile(source)).digest('hex')
    if (digest !== SOURCE.sha256) throw new Error(`the source changed after it was fetched (${digest})`)

    const output = join(workDir, name)
    const compiler =
      process.platform === 'win32'
        ? await compileOnWindows({ source, output, workDir })
        : await compileOnUnix({ source, output, arch: archFlagFor(platformKey), workDir })

    await mkdir(outputDir, { recursive: true })
    await writeFile(target, await readFile(output))
    if (!platformKey.startsWith('win32')) await chmod(target, 0o755)
    await rm(marker, { force: true })
    return { state: 'built', path: target, compiler }
  } catch (error) {
    await mkdir(outputDir, { recursive: true })
    await writeFile(marker, `${error.message}\n`)
    return { state: 'skipped', reason: error.message }
  }
}
