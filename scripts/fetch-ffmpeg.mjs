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
 *     on Windows, with nothing lost. Pinned to a month-end build, which BtbN
 *     keeps for two years; the daily ones are deleted after a fortnight.
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
 * Every download is held to a pinned SHA-256 and discarded if it does not
 * match. These binaries go inside a signed installer, so what ships has to be
 * what was chosen rather than what happened to be at a URL that day. To move
 * to a newer build, change the tag and the checksum together — GitHub lists a
 * `digest` for every release asset.
 *
 * `qt-faststart` is fetched too, as source, and compiled here: none of these
 * builds ships one, and without it the app remuxes a whole file to move an
 * MP4's index. It is optional — a machine with no C compiler simply does not
 * get it, and the app does what it always did.
 *
 * `npm run fetch:ffmpeg` fetches this machine's platform; `-- --all` fetches
 * every platform, which is what building installers needs. `-- --force`
 * re-downloads binaries that are already present.
 */

import { createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { assertChecksum, hashingTap } from './lib/checksum.mjs'
import { licenseOf } from './lib/ffmpeg-license.mjs'
import { ensureQtFaststart } from './lib/qt-faststart.mjs'
import { ensureMp4Tags } from './lib/mp4tags.mjs'

const execFileAsync = promisify(execFile)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN_ROOT = join(ROOT, 'resources', 'bin')
const WANTED = ['ffmpeg', 'ffprobe']

/**
 * BtbN's build of the n8.1 release branch, pinned to one autobuild.
 *
 * Not `latest`: that tag is re-pointed every day, so it cannot be held to a
 * checksum and a build made tomorrow would ship something nobody had looked
 * at. A month-end autobuild is used because those are the ones BtbN keeps.
 */
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59'

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
 * `sha256` is of the file as downloaded, before anything is unpacked.
 *
 * @type {Record<string, {kind: 'archive', url: string, sha256: string, format: 'zip'|'tar'} |
 *                       {kind: 'files', urls: Record<string, string>, sha256: Record<string, string>, gzip: boolean}>}
 */
const TARGETS = {
  'win32-x64': {
    kind: 'archive',
    url: `${BTBN}/ffmpeg-n8.1.3-27-g8dca1586f4-win64-gpl-shared-8.1.zip`,
    sha256: '3adc00b67118a8c4bdd6624a000e139df283b1eeb8b126fcec4849bd5b778dd4',
    format: 'zip',
    libraries: /\.dll$/i
  },
  'linux-x64': {
    kind: 'archive',
    url: `${BTBN}/ffmpeg-n8.1.3-27-g8dca1586f4-linux64-gpl-shared-8.1.tar.xz`,
    sha256: '202fe67679a0860b155817a0907ffcc5c1ea82e186acaa21cb87d307f54fd59a',
    format: 'tar',
    libraries: /\.so(\.\d+)*$/
  },
  'darwin-arm64': {
    kind: 'archive',
    url: `${VODES}/ffmpeg-9.0.2-macos-arm64.tar.zst`,
    sha256: 'e7ed65ac085531e99e5421342bee50c9ca53b3bf10f54f5b024d7cd80ca17386',
    format: 'tar'
  },
  'darwin-x64': {
    kind: 'files',
    gzip: false,
    urls: {
      ffmpeg: `${SHAKA}/ffmpeg-osx-x64`,
      ffprobe: `${SHAKA}/ffprobe-osx-x64`
    },
    sha256: {
      ffmpeg: '241c8d5718ceb8b6741887cc13b70cf2b07bf5393356407c83fafe798d0b0930',
      ffprobe: 'c5a93f563e7b3e27b73af99aaa1b06db4140c6ed2ae0e1baa2819f648b0dc87e'
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

/**
 * Download a file, and keep it only if it is the one that was pinned.
 *
 * The checksum is of the bytes as they arrive — before any gunzip — because
 * that is what the release page lists and what can be compared against it.
 */
async function download(url, destination, { gzip = false, sha256 } = {}) {
  const name = basename(new URL(url).pathname)
  // Before the request, not after it: a source with nothing pinned should not
  // cost a 90 MB download to find out.
  assertChecksum(name, sha256, sha256)

  process.stdout.write(`  fetching ${name}\n`)
  const body = await openStream(url)
  const sink = createWriteStream(destination)
  const { tap, digest } = hashingTap()
  if (gzip) await pipeline(body, tap, createGunzip(), sink)
  else await pipeline(body, tap, sink)

  try {
    assertChecksum(name, digest(), sha256)
  } catch (error) {
    // Not left lying in the work directory for the extraction step to find.
    await rm(destination, { force: true })
    throw error
  }
  process.stdout.write(`  checksum matches ${sha256.slice(0, 12)}…\n`)
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

/**
 * Move a downloaded file into place, around the two ways this fails for real.
 *
 * A temp directory on another volume gives EXDEV, which CI runners do often.
 * Windows gives EPERM, because a rename needs delete access to the source and
 * something else is holding the file open: Defender scans an executable the
 * moment it is closed, and a freshly extracted ffmpeg.exe is about the most
 * interesting thing it will see all day. That scan ends in a moment, so the
 * rename is retried before falling back to a copy — which needs only to read
 * the source, and so goes through while the scan is still running.
 */
async function move(from, to) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (error.code === 'EXDEV') break
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      if (attempt === 5) break
      await delay(100 * 2 ** attempt)
    }
  }
  await copyFile(from, to)
  // The source sits in a temp directory that is removed wholesale afterwards,
  // so a lock that outlives the copy is not worth failing the fetch over.
  await rm(from, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}

/**
 * Build `qt-faststart` into the platform folder, and say what happened.
 *
 * Never throws: the app falls back to ffmpeg's own two-pass move without it,
 * which is what it did before this existed, and an optional speed-up must not
 * fail a fetch that otherwise worked.
 */
async function addQtFaststart(platformKey, outputDir, workDir, force) {
  const result = await ensureQtFaststart({
    platformKey,
    outputDir,
    workDir: join(workDir, 'qt-faststart'),
    force,
    download,
  })
  if (result.state === 'built') {
    console.log(`  → qt-faststart (compiled with ${result.compiler})`)
  } else if (result.state === 'skipped') {
    console.log(`  no qt-faststart: ${result.reason}`)
    console.log('    ffmpeg moves the MP4 index instead, by rewriting the file twice.')
  }
}

/**
 * Build `mp4tags` into the platform folder, and say what happened.
 *
 * Never throws, for the same reason `qt-faststart` does not: without it the app
 * writes tags by remuxing, which is what it did before this existed.
 */
async function addMp4Tags(platformKey, outputDir, workDir, force) {
  const result = await ensureMp4Tags({
    platformKey,
    outputDir,
    workDir: join(workDir, 'mp4v2'),
    force,
    download,
  })
  if (result.state === 'built') {
    console.log(`  → mp4tags (mp4v2 ${result.version}, compiled here)`)
  } else if (result.state === 'skipped') {
    console.log(`  no mp4tags: ${result.reason}`)
    console.log('    tag edits will rewrite the file through ffmpeg instead.')
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

  const present = await Promise.all(WANTED.map((name) => fileExists(finalPaths[name])))
  const haveFfmpeg = !force && present.every(Boolean)
  if (haveFfmpeg) {
    console.log(`\n${platformKey}: ffmpeg already present, skipping (use --force to replace).`)
  } else {
    console.log(`\n${platformKey}:`)
  }

  await mkdir(outputDir, { recursive: true })
  const workDir = await mkdtemp(join(tmpdir(), 'plexfixer-ffmpeg-'))

  try {
    // Always, even when the binaries above were already here: qt-faststart is
    // newer than they are, so a checkout that predates it has ffmpeg and no
    // qt-faststart, and skipping the whole target would never add one.
    if (haveFfmpeg) {
      await addQtFaststart(platformKey, outputDir, workDir, force)
      await addMp4Tags(platformKey, outputDir, workDir, force)
      return
    }
    if (target.kind === 'files') {
      for (const name of WANTED) {
        const url = target.urls[name]
        if (!url) throw new Error(`no URL configured for ${name}`)
        // Download to a scratch path first so an interrupted fetch cannot leave
        // a truncated binary sitting where the app would try to run it.
        const scratch = join(workDir, exeName(platformKey, name))
        await download(url, scratch, { gzip: target.gzip, sha256: target.sha256?.[name] })
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
    await download(target.url, archivePath, { sha256: target.sha256 })

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

    await addQtFaststart(platformKey, outputDir, workDir, force)
    await addMp4Tags(platformKey, outputDir, workDir, force)
  } finally {
    // Retries for the same reason `move` has them: a scanner still holding one
    // of the files it just unpacked would otherwise fail a fetch that worked.
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      (error) => console.warn(`  ! could not remove ${workDir}: ${error.message}`),
    )
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
