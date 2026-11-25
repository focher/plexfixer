/**
 * Building `mp4tags` from mp4v2's own source.
 *
 * Changing a title or an episode number used to rewrite the whole file. ffmpeg
 * cannot do better: `-c copy` demuxes and remuxes, so a two-word edit to a
 * 30 GB film reads and writes 30 GB. The app's own in-place patcher handles
 * language tags and default flags, because those are fixed-width fields that
 * can be overwritten where they lie — but a title is text of any length, so
 * `moov` changes size and everything after it would shift.
 *
 * mp4v2 solves exactly that, and has for twenty years: it keeps `free` padding
 * beside the header and rewrites the chunk-offset tables when the header has to
 * move, so `mdat` never does. Measured against a 12 MB file: same inode, 0.00s
 * of CPU, and the only bytes that changed were in the header. That is the
 * difference between instant and minutes, and it is why Subler — which is built
 * on this same library — feels the way it does.
 *
 * It is built here rather than downloaded because mp4v2 publishes source and
 * nothing else: no project ships a prebuilt `mp4tags` for Windows or for either
 * macOS architecture. The source is one pinned tarball, checksummed like every
 * other download — this one is compiled and put inside a signed installer,
 * which is the strongest reason of all to know exactly what arrived.
 *
 * A machine with no compiler, or no CMake, is not an error. Without `mp4tags`
 * the app writes tags the way it always has, by remuxing, and failing a build
 * over an optional speed-up would be the wrong trade.
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
 * `enzo1982/mp4v2` is the maintained fork — the original project was abandoned
 * at 2.0.0 and this one carries the fixes. The tarball is 594 KB of C++ with no
 * dependencies beyond a standard library, which is what makes building it here
 * reasonable at all.
 *
 * The hash is of the archive as downloaded, before anything is unpacked.
 */
export const SOURCE = {
  url: 'https://github.com/enzo1982/mp4v2/releases/download/v2.1.3/mp4v2-2.1.3.tar.bz2',
  sha256: '033185c17bf3c5fdd94020c95f8325be2e5356558e3913c3d6547a85dd61f7f1',
  version: '2.1.3',
}

/** Left in a platform folder when the build could not be done here. */
export const UNAVAILABLE = '.mp4tags-unavailable'

/**
 * The architecture to compile for, per platform folder.
 *
 * Stated rather than left to CMake, which asks the *toolchain* rather than the
 * machine. A Homebrew CMake installed under Rosetta reports x86_64 on an Apple
 * Silicon Mac, and the build then quietly produces an Intel binary that the
 * app would ship to arm64 users and never run. Found exactly that way.
 */
const ARCHITECTURE = {
  'darwin-arm64': 'arm64',
  'darwin-x64': 'x86_64',
}

export function toolName(platformKey) {
  return platformKey.startsWith('win32') ? 'mp4tags.exe' : 'mp4tags'
}

/** Whether this platform folder already has one. */
export function haveMp4Tags(outputDir, platformKey) {
  return existsSync(join(outputDir, toolName(platformKey)))
}

async function sha256Of(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Whether a command exists and runs, which is how a missing tool is detected. */
async function canRun(command, args) {
  try {
    await execFileAsync(command, args)
    return true
  } catch {
    return false
  }
}

/**
 * Build `mp4tags` into `outputDir`.
 *
 * Returns what happened rather than throwing, so a caller can report it and
 * carry on. `{ state: 'built' }`, `{ state: 'present' }` when one is already
 * there, or `{ state: 'skipped', reason }`.
 */
export async function ensureMp4Tags({ platformKey, outputDir, workDir, force, download }) {
  const target = join(outputDir, toolName(platformKey))
  const marker = join(outputDir, UNAVAILABLE)

  if (!force && existsSync(target)) return { state: 'present' }
  if (!force && existsSync(marker)) {
    return { state: 'skipped', reason: 'tried before on this machine and could not' }
  }

  // Cross-compiling is not attempted: a Windows binary needs a Windows
  // toolchain, and an Intel one needs a macOS SDK that can target it. CI runs
  // this on each platform's own runner, which is where it belongs.
  const host = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  if (!platformKey.startsWith(host)) {
    return { state: 'skipped', reason: `${platformKey} must be built on ${host === 'darwin' ? 'macOS' : host}` }
  }
  if (host === 'darwin' && !ARCHITECTURE[platformKey]) {
    return { state: 'skipped', reason: `no architecture known for ${platformKey}` }
  }

  if (!(await canRun('cmake', ['--version']))) {
    await note(marker, 'cmake is not installed')
    return { state: 'skipped', reason: 'cmake is not installed' }
  }

  await mkdir(workDir, { recursive: true })
  const archive = join(workDir, 'mp4v2.tar.bz2')
  const source = join(workDir, 'source')
  const build = join(workDir, 'build')

  try {
    // The hash goes to the downloader, which refuses to fetch anything it has
    // not been given one for — and it is checked again here afterwards, so
    // this module is honest on its own rather than relying on its caller.
    await download(SOURCE.url, archive, { sha256: SOURCE.sha256 })
    const got = await sha256Of(archive)
    if (got !== SOURCE.sha256) {
      // Never built: a checksum that does not match is either the wrong file
      // or a tampered one, and this one gets compiled into a signed installer.
      throw new Error(`checksum mismatch — expected ${SOURCE.sha256}, got ${got}`)
    }

    await mkdir(source, { recursive: true })
    await execFileAsync('tar', ['-xf', archive, '-C', source, '--strip-components=1'])

    const configure = [
      '-S',
      source,
      '-B',
      build,
      '-DCMAKE_BUILD_TYPE=Release',
      // Static: the tool is shipped on its own, and a .dylib or .dll beside it
      // is another file to sign, notarize and get wrong.
      '-DBUILD_SHARED=OFF',
      '-DBUILD_UTILS=ON',
    ]
    if (host === 'darwin') {
      configure.push(`-DCMAKE_OSX_ARCHITECTURES=${ARCHITECTURE[platformKey]}`)
      // The same floor the rest of the app is built against.
      configure.push('-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0')
    }

    await execFileAsync('cmake', configure)
    await execFileAsync('cmake', ['--build', build, '--config', 'Release', '--target', 'mp4tags', '--parallel', '4'])

    // CMake puts it beside the build root, or under Release/ with a
    // multi-config generator, which is what Visual Studio is.
    const built = [join(build, toolName(platformKey)), join(build, 'Release', toolName(platformKey))].find((path) =>
      existsSync(path)
    )
    if (!built) throw new Error('the build reported success but produced no mp4tags')

    await writeFile(target, await readFile(built))
    await chmod(target, 0o755)
    await rm(marker, { force: true })
    return { state: 'built', version: SOURCE.version }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await note(marker, reason)
    return { state: 'skipped', reason }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

async function note(marker, reason) {
  try {
    await writeFile(marker, `${new Date().toISOString()} ${reason}\n`)
  } catch {
    /* a note that cannot be written is not worth failing over */
  }
}
