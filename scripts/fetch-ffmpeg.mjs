#!/usr/bin/env node
/**
 * Download static ffmpeg/ffprobe binaries into `resources/bin/<platform>-<arch>/`
 * so electron-builder can bundle them.
 *
 * Sources are the upstream projects' own release artifacts:
 *   - Windows / Linux: BtbN/FFmpeg-Builds (GPL builds, which include NVENC)
 *   - macOS x64:       evermeet.cx
 *
 * macOS arm64 has no maintained static build that is safe to pin, so Apple
 * Silicon falls back to whatever ffmpeg is on PATH (Homebrew's `ffmpeg` works).
 * `npm run fetch:ffmpeg -- --all` fetches every platform, which is what a
 * release build needs.
 */

import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname
const BIN_ROOT = join(ROOT, 'resources', 'bin')

/** @type {Record<string, {url: string, archive: 'zip'|'tar.xz', strip?: string} | null>} */
const TARGETS = {
  'win32-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    archive: 'zip'
  },
  'linux-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
    archive: 'tar.xz'
  },
  'darwin-x64': {
    url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    archive: 'zip'
  },
  // No maintained static arm64 build to pin; PATH lookup covers it.
  'darwin-arm64': null
}

const WANTED = ['ffmpeg', 'ffprobe']

async function download(url, destination) {
  process.stdout.write(`  fetching ${url}\n`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`)
  }
  await pipeline(response.body, createWriteStream(destination))
}

async function extract(archivePath, kind, intoDir) {
  if (kind === 'zip') {
    // bsdtar ships with macOS and Windows 10+; unzip is the Linux fallback.
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

/** Find the wanted executables anywhere inside the extracted tree. */
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

async function fetchTarget(key) {
  const target = TARGETS[key]
  if (target === undefined) throw new Error(`Unknown target "${key}"`)

  if (target === null) {
    console.log(`\n${key}: no static build available — PlexFixer will use ffmpeg from PATH.`)
    if (key === 'darwin-arm64') console.log('  Install one with: brew install ffmpeg')
    return
  }

  const outputDir = join(BIN_ROOT, key)
  const already = await Promise.all(
    WANTED.map(async (name) => {
      const file = join(outputDir, key.startsWith('win32') ? `${name}.exe` : name)
      try {
        await stat(file)
        return true
      } catch {
        return false
      }
    })
  )
  if (already.every(Boolean)) {
    console.log(`\n${key}: already present, skipping.`)
    return
  }

  console.log(`\n${key}:`)
  const workDir = await mkdtemp(join(tmpdir(), 'plexfixer-ffmpeg-'))
  try {
    const archivePath = join(workDir, `archive.${target.archive.replace('.', '-')}`)
    await download(target.url, archivePath)

    const extractDir = join(workDir, 'extracted')
    await mkdir(extractDir, { recursive: true })
    await extract(archivePath, target.archive, extractDir)

    const found = await findBinaries(extractDir)
    const missing = WANTED.filter((name) => !found.has(name))
    if (missing.length > 0) throw new Error(`archive did not contain ${missing.join(' and ')}`)

    await mkdir(outputDir, { recursive: true })
    for (const [name, sourcePath] of found) {
      const fileName = key.startsWith('win32') ? `${name}.exe` : name
      const targetPath = join(outputDir, fileName)
      await rename(sourcePath, targetPath).catch(async (error) => {
        // Cross-device rename fails on some CI runners; fall back to a copy.
        if (error.code !== 'EXDEV') throw error
        const { copyFile } = await import('node:fs/promises')
        await copyFile(sourcePath, targetPath)
      })
      if (!key.startsWith('win32')) await chmod(targetPath, 0o755)
      console.log(`  → ${targetPath}`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const keys = args.includes('--all') ? Object.keys(TARGETS) : [`${process.platform}-${process.arch}`]

let failed = false
for (const key of keys) {
  try {
    await fetchTarget(key)
  } catch (error) {
    failed = true
    console.error(`\n${key}: ${error.message}`)
  }
}

if (failed) {
  console.error('\nSome binaries could not be fetched. PlexFixer will fall back to ffmpeg on PATH.')
  process.exitCode = 1
} else {
  console.log('\nDone.')
}
