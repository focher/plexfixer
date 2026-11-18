/**
 * What ends up inside an installer.
 *
 * Two files have escaped into a shipped one so far, and both got there the
 * same way: they were sitting in the directory Tauri bundles, and the copy
 * that filled it took everything it found. 0.2.3 shipped the note a failed
 * qt-faststart compile leaves behind; every build up to 0.2.5 shipped the
 * .gitkeep that used to hold the staging directory open for tauri-build.
 *
 * So these tests are about absence: that bookkeeping stays on the build
 * machine, and that nothing survives in the staging directory from one build
 * to the next.
 */

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM helper shared with the build scripts
import { isPayload, payloadOf, stageResources } from '../scripts/lib/stage-resources.mjs'

let dir: string
let stage: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-stage-'))
  stage = join(dir, 'stage')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A platform folder as `npm run fetch:ffmpeg` leaves it. */
async function source(folder: string, files: string[]): Promise<string> {
  const path = join(dir, 'source', folder)
  await mkdir(path, { recursive: true })
  for (const name of files) await writeFile(join(path, name), name)
  return path
}

async function listed(path: string): Promise<string[]> {
  return (await readdir(path)).sort()
}

describe('telling payload from bookkeeping', () => {
  it('ships binaries', () => {
    expect(isPayload('/x/resources/bin/win32-x64/ffmpeg.exe')).toBe(true)
    expect(isPayload('qt-faststart.exe')).toBe(true)
  })

  it('leaves behind the note about a compile that did not happen', () => {
    expect(isPayload('/x/resources/bin/win32-x64/.qt-faststart-unavailable')).toBe(false)
  })

  it('leaves behind a keepfile', () => {
    expect(isPayload('.gitkeep')).toBe(false)
  })

  it('judges the file, not the folders above it', () => {
    expect(isPayload('/Users/someone/.config/build/resources/bin/ffmpeg')).toBe(true)
  })
})

describe('what a platform folder is worth staging for', () => {
  it('counts binaries only, so a folder holding just a note reads as empty', async () => {
    const path = await source('win32-x64', ['.qt-faststart-unavailable'])
    expect(await payloadOf(path)).toEqual([])
  })

  it('counts the binaries that are there', async () => {
    const path = await source('win32-x64', ['ffmpeg.exe', 'ffprobe.exe', '.gitkeep'])
    expect((await payloadOf(path)).sort()).toEqual(['ffmpeg.exe', 'ffprobe.exe'])
  })
})

describe('filling the staging directory', () => {
  it('copies the payload and nothing else', async () => {
    const path = await source('win32-x64', [
      'ffmpeg.exe',
      'qt-faststart.exe',
      '.qt-faststart-unavailable',
    ])
    await stageResources({ stage, sources: [{ folder: 'win32-x64', source: path }] })

    expect(await listed(stage)).toEqual(['win32-x64'])
    expect(await listed(join(stage, 'win32-x64'))).toEqual(['ffmpeg.exe', 'qt-faststart.exe'])
  })

  it('drops the binaries the previous build staged for another target', async () => {
    await mkdir(join(stage, 'darwin-arm64'), { recursive: true })
    await writeFile(join(stage, 'darwin-arm64', 'ffmpeg'), 'old')

    const path = await source('win32-x64', ['ffmpeg.exe'])
    await stageResources({ stage, sources: [{ folder: 'win32-x64', source: path }] })

    expect(await listed(stage)).toEqual(['win32-x64'])
  })

  it('clears a loose file left in the staging directory itself', async () => {
    // The .gitkeep that used to live here is gone from the repository, but a
    // checkout that predates that still has one on disk. It is not payload and
    // it is not a folder, which is exactly the gap that shipped it.
    await mkdir(stage, { recursive: true })
    await writeFile(join(stage, '.gitkeep'), '')

    const path = await source('win32-x64', ['ffmpeg.exe'])
    await stageResources({ stage, sources: [{ folder: 'win32-x64', source: path }] })

    expect(await listed(stage)).toEqual(['win32-x64'])
  })

  it('stages both slices of a universal build', async () => {
    const arm = await source('darwin-arm64', ['ffmpeg'])
    const intel = await source('darwin-x64', ['ffmpeg'])
    await stageResources({
      stage,
      sources: [
        { folder: 'darwin-arm64', source: arm },
        { folder: 'darwin-x64', source: intel },
      ],
    })

    expect(await listed(stage)).toEqual(['darwin-arm64', 'darwin-x64'])
  })

  it('creates the staging directory when there is none', async () => {
    const path = await source('linux-x64', ['ffmpeg'])
    await stageResources({ stage, sources: [{ folder: 'linux-x64', source: path }] })

    expect(await listed(join(stage, 'linux-x64'))).toEqual(['ffmpeg'])
  })
})
