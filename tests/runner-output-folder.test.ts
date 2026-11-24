/**
 * The folder the repaired file goes in.
 *
 * With an output directory set, PlexFixer mirrors the library's shape under
 * it — a folder per film — so the first repair of a film writes into a folder
 * that does not exist yet. ffmpeg does not create the folder it is pointed at:
 * it opens the output file and stops with "No such file or directory" before
 * reading a frame, which is how a 27 GB transcode failed in under a second.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '../src/shared/plex/analyze.js'
import { RepairRunner } from '@shared/plex/runner.js'
import { localHost } from './node-host.js'
import { mainAudio, mkv, video } from './fixtures.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-output-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * An ffmpeg that does what ffmpeg does to its output file and nothing else:
 * opens it, and fails if it cannot. It records which, then exits non-zero so
 * the job ends there rather than going on to probe a file that is empty.
 */
async function recordingFfmpeg(markerPath: string): Promise<string> {
  const path = join(dir, 'fake-ffmpeg.sh')
  await writeFile(
    path,
    '#!/bin/sh\n' +
      'for arg in "$@"; do last="$arg"; done\n' +
      `if printf '' > "$last" 2>/dev/null; then echo "opened" > "${markerPath}";\n` +
      `else echo "could not open" > "${markerPath}"; fi\n` +
      'exit 1\n'
  )
  await chmod(path, 0o755)
  return path
}

describe('writing into an output directory that does not exist yet', () => {
  it('creates the folder before ffmpeg is asked to write in it', async () => {
    const library = join(dir, 'library')
    const source = join(library, 'Example (2020)', 'Example (2020).mkv')
    await mkdir(join(library, 'Example (2020)'), { recursive: true })
    await writeFile(source, 'not really a film')

    const marker = join(dir, 'marker.txt')
    const outputRoot = join(dir, 'out')

    const result = analyzeFile(
      mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'spa' })], { path: source }),
      DEFAULT_SETTINGS
    )

    const runner = new RepairRunner(
      { ffmpegPath: await recordingFfmpeg(marker), ffprobePath: await recordingFfmpeg(marker) },
      1,
      () => undefined,
      localHost()
    )

    const job = runner.enqueue({
      result,
      settings: { ...DEFAULT_SETTINGS, outputPlacement: 'output-dir', outputDirectory: outputRoot },
      mode: 'safe-remux',
      scanRoot: library
    })

    await settle(600)

    // The job itself fails — the fake ffmpeg always exits 1 — but it must fail
    // *after* having been able to open its output, not before.
    expect(await readFile(marker, 'utf8')).toContain('opened')
    const folder = await stat(join(outputRoot, 'Example (2020)'))
    expect(folder.isDirectory()).toBe(true)

    runner.cancel(job.id)
    await settle(100)
  })
})
