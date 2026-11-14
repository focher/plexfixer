#!/usr/bin/env node
/**
 * Download static ffmpeg/ffprobe binaries into `resources/bin/<platform>-<arch>/`
 * so the bundler can ship them.
 *
 * Sources, all from the projects' own release artifacts:
 *   - Windows / Linux: BtbN/FFmpeg-Builds, the n8.1 release branch. These are
 *     GPL builds, which is what carries NVENC and libx264. The *shared* build
 *     is used rather than the static one: a static ffmpeg and a static ffprobe
 *     each embed the whole of libav*, so bundling both shipped the same 150 MB
 *     of codecs twice. Shared, the two executables come to under a megabyte
 *     between them and the libraries are carried once — 315 MB down to 190 MB
 *     on Windows, with nothing lost.
 *   - macOS x64: shaka-project/static-ffmpeg-binaries, pinned to a release
 *     tag. BtbN does not build for macOS, and evermeet.cx (the long-standing
 *     macOS source) now returns HTTP 410.
 *   - macOS arm64: Vodes/ffmpeg-mt, pinned to a release tag. The shaka build
 *     is minimal — no libplacebo — and libplacebo is the only thing in ffmpeg
 *     that can read a Dolby Vision RPU, so without it a Mac cannot convert
 *     profile 5 at all. This build has it, with Vulkan and MoltenVK linked in
 *     statically so there is nothing to install alongside. It only exists for
 *     arm64, which is why the two architectures now come from two upstreams
 *     again — the difference from 0.1.1 is that both are checked for
 *     `--enable-nonfree` before they are allowed anywhere near an installer.
 *     An Intel Mac keeps the shaka build and reports the conversion as
 *     unavailable rather than doing it wrong.
 *
 * `npm run fetch:ffmpeg` fetches this machine's platform; `-- --all` fetches
 * every platform, which is what building installers needs. `-- --force`
 * re-downloads binaries that are already present.
 */

import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { licenseOf } from './lib/ffmpeg-license.mjs'

const execFileAsync = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname
const BIN_ROOT = join(ROOT, 'resources', 'bin')
const WANTED = ['ffmpeg', 'ffprobe']

/** BtbN's rolling pointer at the n8.1 release branch. */
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'

/** Platforms `--all` fetches: the ones `npm run dist` actually builds. */
const SHIPPED = ['darwin-arm64', 'darwin-x64', 'win32-x64']
/**
 * Pinned release of the macOS x64 static build — FFmpeg 8.1.2, the same
 * release line BtbN ships for Windows, built GPL v3 with libx264, libx265 and
 * VideoToolbox. The tag suffix (`-2`) is the packaging revision. arm64 comes
 * from VODES below instead, for libplacebo.
 */
const SHAKA = 'https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.1.2-2'

/**
 * Pinned release of the macOS arm64 build with libplacebo — FFmpeg 9.0.2,
 * GPL v3, statically linked including MoltenVK. The `-r1` tag is the free
 * build; `-r1-nonfree` is the same thing with undistributable extras, and
 * `assertDistributable` would refuse it.
 */
const VODES = 'https://github.com/Vodes/ffmpeg-mt/releases/download/v9.0.2-r1'

/**
 * `archive` targets download one bundle and are searched for the binaries.
 * `files` targets download each binary separately, gunzipping as they go.
 *
 * @type {Record<string, {kind: 'archive', url: string, format: 'zip'|'tar'} |
 *                       {kind: 'files', urls: Record<string, string>, gzip: boolean}>}
 */
const TARGETS = {
  'win32-x64': {
    kind: 'archive',
    url: `${BTBN}/ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip`,
    format: 'zip',
    libraries: /\.dll$/i
  },
  'linux-x64': {
    kind: 'archive',
    url: `${BTBN}/ffmpeg-n8.1-latest-linux64-gpl-shared-8.1.tar.xz`,
    format: 'tar',
    libraries: /\.so(\.\d+)*$/
  },
  'darwin-arm64': {
    kind: 'archive',
    url: `${VODES}/ffmpeg-9.0.2-macos-arm64.tar.zst`,
    format: 'tar'
  },
  'darwin-x64': {
    kind: 'files',
    gzip: false,
    urls: {
      ffmpeg: `${SHAKA}/ffmpeg-osx-x64`,
      ffprobe: `${SHAKA}/ffprobe-osx-x64`
    }
  }
}

function exeName(platformKey, name) {
  return platformKey.startsWith('win32') ? `${name}.exe` : name
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function openStream(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`)
  }
  return response.body
}

async function download(url, destination, { gzip = false } = {}) {
  process.stdout.write(`  fetching ${basename(new URL(url).pathname)}\n`)
  const body = await openStream(url)
  const sink = createWriteStream(destination)
  if (gzip) await pipeline(body, createGunzip(), sink)
  else await pipeline(body, sink)
}

async function extract(archivePath, format, intoDir) {
  if (format === 'zip') {
    // bsdtar reads zips and ships with macOS and Windows 10+; unzip covers the
    // Linux case where tar is GNU tar.
    try {
      await execFileAsync('tar', ['-xf', archivePath, '-C', intoDir])
      return
    } catch {
      await execFileAsync('unzip', ['-q', '-o', archivePath, '-d', intoDir])
      return
    }
  }
  await execFileAsync('tar', ['-xf', archivePath, '-C', intoDir])
}

/** Find the wanted executables anywhere inside an extracted tree. */
async function findBinaries(dir, found = new Map()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await findBinaries(full, found)
    } else if (entry.isFile()) {
      const stem = basename(entry.name, '.exe').toLowerCase()
      if (WANTED.includes(stem) && !found.has(stem)) found.set(stem, full)
    }
  }
  return found
}

/**
 * Shared-library files that have to travel with the executables.
 *
 * They sit beside ffmpeg in the archive's `bin` (Windows) or in a sibling
 * `lib` (Linux). ffplay is not one of ours and is the largest thing in the
 * archive after avcodec, so it is left behind.
 */
async function findLibraries(dir, pattern, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await findLibraries(full, pattern, found)
    else if (entry.isFile() && pattern.test(entry.name) && !entry.name.startsWith('ffplay')) found.push(full)
  }
  return found
}

/**
 * Refuse a build nobody is allowed to redistribute.
 *
 * `--enable-nonfree` produces a binary that may be used but not shipped: it is
 * the one configure flag that makes an installer undistributable, and it is
 * invisible unless you go looking. v0.1.1's macOS arm64 build carried it into
 * a published DMG, which is why this check exists.
 */
async function assertDistributable(path, platformKey, allowNonfree) {
  const license = await licenseOf(path)
  if (license.redistributable === 'unknown') {
    console.log('  ! could not read the build configuration from this binary')
    return
  }
  if (license.redistributable) return

  if (allowNonfree) {
    console.log(`  ! ${basename(path)} is an --enable-nonfree build: usable here, NOT redistributable`)
    return
  }
  throw new Error(
    `${basename(path)} is built with --enable-nonfree.\n` +
      '  Such a build may be used but not redistributed, so it must not go into an\n' +
      '  installer. Pin a different source in TARGETS, build one from source, or pass\n' +
      `  --allow-nonfree to fetch it anyway for local use on ${platformKey}.`
  )
}

/** Cross-device rename fails on some CI runners; fall back to a copy. */
async function move(from, to) {
  try {
    await rename(from, to)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    const { copyFile } = await import('node:fs/promises')
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

async function fetchTarget(platformKey, { force, allowNonfree }) {
  const target = TARGETS[platformKey]
  if (!target) {
    console.log(`\n${platformKey}: no source configured — PlexFixer will use ffmpeg from PATH.`)
    return
  }

  const outputDir = join(BIN_ROOT, platformKey)
  const finalPaths = Object.fromEntries(
    WANTED.map((name) => [name, join(outputDir, exeName(platformKey, name))])
  )

  if (!force) {
    const present = await Promise.all(WANTED.map((name) => fileExists(finalPaths[name])))
    if (present.every(Boolean)) {
      console.log(`\n${platformKey}: already present, skipping (use --force to replace).`)
      return
    }
  }

  console.log(`\n${platformKey}:`)
  await mkdir(outputDir, { recursive: true })
  const workDir = await mkdtemp(join(tmpdir(), 'plexfixer-ffmpeg-'))

  try {
    if (target.kind === 'files') {
      for (const name of WANTED) {
        const url = target.urls[name]
        if (!url) throw new Error(`no URL configured for ${name}`)
        // Download to a scratch path first so an interrupted fetch cannot leave
        // a truncated binary sitting where the app would try to run it.
        const scratch = join(workDir, exeName(platformKey, name))
        await download(url, scratch, { gzip: target.gzip })
        await assertDistributable(scratch, platformKey, allowNonfree)
        await move(scratch, finalPaths[name])
        if (!platformKey.startsWith('win32')) await chmod(finalPaths[name], 0o755)
        console.log(`  → ${finalPaths[name]}`)
      }
      return
    }

    // Named after the real file: tar picks its decompressor from the content,
    // but a zstd archive called `.tar` is a trap for anyone reading the code.
    const archivePath = join(workDir, basename(new URL(target.url).pathname))
    await download(target.url, archivePath)

    const extractDir = join(workDir, 'extracted')
    await mkdir(extractDir, { recursive: true })
    await extract(archivePath, target.format, extractDir)

    const found = await findBinaries(extractDir)
    const missing = WANTED.filter((name) => !found.has(name))
    if (missing.length > 0) throw new Error(`archive did not contain ${missing.join(' and ')}`)

    for (const name of WANTED) {
      await assertDistributable(found.get(name), platformKey, allowNonfree)
      await move(found.get(name), finalPaths[name])
      if (!platformKey.startsWith('win32')) await chmod(finalPaths[name], 0o755)
      console.log(`  → ${finalPaths[name]}`)
    }

    if (target.libraries) {
      // A shared build's executables are useless on their own; the libraries
      // go into the same folder, which is where the loader looks first.
      const libraries = await findLibraries(extractDir, target.libraries)
      if (libraries.length === 0) throw new Error('shared build contained no libraries')
      let bytes = 0
      for (const library of libraries) {
        const destination = join(outputDir, basename(library))
        bytes += (await stat(library)).size
        await move(library, destination)
        if (!platformKey.startsWith('win32')) await chmod(destination, 0o755)
      }
      console.log(`  → ${libraries.length} shared libraries (${(bytes / 1048576).toFixed(0)} MB)`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const allowNonfree = args.includes('--allow-nonfree')
// An explicit platform key wins, so linux-x64 can still be fetched by name
// even though `--all` no longer includes a platform we do not ship.
const explicit = args.filter((arg) => !arg.startsWith('--'))
const keys =
  explicit.length > 0 ? explicit : args.includes('--all') ? SHIPPED : [`${process.platform}-${process.arch}`]

const failures = []
for (const key of keys) {
  try {
    await fetchTarget(key, { force, allowNonfree })
  } catch (error) {
    failures.push(`${key}: ${error.message}`)
    console.error(`\n${key}: FAILED — ${error.message}`)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} target(s) could not be fetched:`)
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('PlexFixer falls back to ffmpeg on PATH for those platforms.')
  process.exitCode = 1
} else {
  console.log('\nDone.')
}
