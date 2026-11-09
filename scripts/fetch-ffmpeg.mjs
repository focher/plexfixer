#!/usr/bin/env node
/**
 * Download static ffmpeg/ffprobe binaries into `resources/bin/<platform>-<arch>/`
 * so electron-builder can bundle them.
 *
 * Sources, all from the projects' own release artifacts:
 *   - Windows / Linux: BtbN/FFmpeg-Builds, the n8.1 release branch. These are
 *     GPL builds, which is what carries NVENC and libx264.
 *   - macOS (arm64 + x64): eugeneware/ffmpeg-static, pinned to a release tag.
 *     BtbN does not build for macOS, and evermeet.cx (the long-standing macOS
 *     source) now returns HTTP 410.
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

const execFileAsync = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname
const BIN_ROOT = join(ROOT, 'resources', 'bin')
const WANTED = ['ffmpeg', 'ffprobe']

/** BtbN's rolling pointer at the n8.1 release branch. */
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
/**
 * Pinned release of the macOS static builds. Note the tag (`b6.1.1`) is the
 * packaging release, not the FFmpeg version — these binaries report 6.0.
 */
const EUGENEWARE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1'

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
    url: `${BTBN}/ffmpeg-n8.1-latest-win64-gpl-8.1.zip`,
    format: 'zip'
  },
  'linux-x64': {
    kind: 'archive',
    url: `${BTBN}/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz`,
    format: 'tar'
  },
  'darwin-arm64': {
    kind: 'files',
    gzip: true,
    urls: {
      ffmpeg: `${EUGENEWARE}/ffmpeg-darwin-arm64.gz`,
      ffprobe: `${EUGENEWARE}/ffprobe-darwin-arm64.gz`
    }
  },
  'darwin-x64': {
    kind: 'files',
    gzip: true,
    urls: {
      ffmpeg: `${EUGENEWARE}/ffmpeg-darwin-x64.gz`,
      ffprobe: `${EUGENEWARE}/ffprobe-darwin-x64.gz`
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

async function fetchTarget(platformKey, { force }) {
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
        await move(scratch, finalPaths[name])
        if (!platformKey.startsWith('win32')) await chmod(finalPaths[name], 0o755)
        console.log(`  → ${finalPaths[name]}`)
      }
      return
    }

    const archivePath = join(workDir, `archive.${target.format}`)
    await download(target.url, archivePath)

    const extractDir = join(workDir, 'extracted')
    await mkdir(extractDir, { recursive: true })
    await extract(archivePath, target.format, extractDir)

    const found = await findBinaries(extractDir)
    const missing = WANTED.filter((name) => !found.has(name))
    if (missing.length > 0) throw new Error(`archive did not contain ${missing.join(' and ')}`)

    for (const name of WANTED) {
      await move(found.get(name), finalPaths[name])
      if (!platformKey.startsWith('win32')) await chmod(finalPaths[name], 0o755)
      console.log(`  → ${finalPaths[name]}`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const keys = args.includes('--all') ? Object.keys(TARGETS) : [`${process.platform}-${process.arch}`]

const failures = []
for (const key of keys) {
  try {
    await fetchTarget(key, { force })
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
