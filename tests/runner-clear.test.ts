/**
 * Emptying the job queue.
 *
 * The awkward part is a job that is still running: ffmpeg has to be killed and
 * the job unwinds asynchronously, so its own "cancelled" update lands after the
 * list has been emptied. It must not put the job back into a list the user just
 * cleared.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '../src/shared/plex/analyze.js'
import { RepairRunner } from '../src/main/jobs/runner.js'
import type { Job } from '../src/shared/types.js'
import { mainAudio, mkv, video } from './fixtures.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-clear-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Stands in for ffmpeg, and takes long enough to still be running when cleared. */
async function slowFfmpeg(): Promise<string> {
  const path = join(dir, 'slow-ffmpeg.sh')
  await writeFile(path, '#!/bin/sh\nsleep 10\n')
  await chmod(path, 0o755)
  return path
}

/** A file that needs a remux, so a job actually reaches ffmpeg. */
const result = analyzeFile(
  mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'spa' })]),
  DEFAULT_SETTINGS
)

async function runner(): Promise<{ instance: RepairRunner; updates: Job[] }> {
  const updates: Job[] = []
  const instance = new RepairRunner(
    { ffmpegPath: await slowFfmpeg(), ffprobePath: await slowFfmpeg() },
    2,
    (job) => updates.push(job)
  )
  return { instance, updates }
}

describe('clearAll', () => {
  it('removes finished and unstarted jobs alike', async () => {
    const { instance } = await runner()
    instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'report' })
    instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'report' })
    // Report-only jobs finish immediately without touching ffmpeg.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(instance.list().length).toBe(2)

    instance.clearAll()
    expect(instance.list()).toEqual([])
  })

  it('does not let a running job come back after it is cleared', async () => {
    const { instance } = await runner()
    instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(instance.list().map((job) => job.state)).toEqual(['running'])

    instance.clearAll()
    expect(instance.list()).toEqual([])

    // The kill, and the job's own report of it, arrive after the list is empty.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(instance.list()).toEqual([])
  })

  it('leaves a later job alone', async () => {
    const { instance } = await runner()
    instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    instance.clearAll()

    const kept = instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'report' })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(instance.list().map((job) => job.id)).toContain(kept.id)
  })
})
