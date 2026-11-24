/**
 * Adding a batch of repairs.
 *
 * Every file is probed on its way into the queue, so adding a hundred of them
 * takes a while. The first file used to start repairing during that wait,
 * which put one repair and a long run of probes on the same disk and left the
 * queue looking half-built while it filled. A batch arriving into an idle
 * queue now waits for the whole batch to be in.
 *
 * A queue that is already working is left alone: it has made its start, and
 * holding it would only idle the slots its running repairs free up.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '../src/shared/plex/analyze.js'
import { RepairRunner } from '@shared/plex/runner.js'
import type { Job } from '../src/shared/types.js'
import { localHost } from './node-host.js'
import { mainAudio, mkv, video } from './fixtures.js'

let dir: string
/**
 * Every runner a test made. The stand-in ffmpeg sleeps, so a repair left
 * running would outlive its test and slow down the rest of the suite.
 */
let made: RepairRunner[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-batch-'))
  made = []
})
afterEach(async () => {
  for (const instance of made) instance.cancelAll()
  await rm(dir, { recursive: true, force: true })
})

/** Stands in for ffmpeg, and runs long enough that a started repair stays started. */
async function slowFfmpeg(): Promise<string> {
  const path = join(dir, 'slow-ffmpeg.sh')
  await writeFile(path, '#!/bin/sh\nsleep 10\n')
  await chmod(path, 0o755)
  return path
}

/** A file that needs a remux, so the job actually reaches ffmpeg. */
function fileNeedingRepair(name: string) {
  return analyzeFile(
    mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'spa' })], {
      // Under the test's own directory: the runner creates the folder the
      // repaired file goes in before ffmpeg is pointed at it.
      path: join(dir, 'Movies', name, `${name}.mkv`),
      fileName: `${name}.mkv`
    }),
    DEFAULT_SETTINGS
  )
}

async function runner(concurrency = 2): Promise<{ instance: RepairRunner; updates: Job[] }> {
  const updates: Job[] = []
  const ffmpeg = await slowFfmpeg()
  const instance = new RepairRunner(
    { ffmpegPath: ffmpeg, ffprobePath: ffmpeg },
    concurrency,
    (job) => updates.push(job),
    localHost()
  )
  made.push(instance)
  return { instance, updates }
}

const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function queue(instance: RepairRunner, name: string): Job {
  return instance.enqueue({
    result: fileNeedingRepair(name),
    settings: DEFAULT_SETTINGS,
    mode: 'safe-remux'
  })
}

function stateOf(instance: RepairRunner, id: string): Job['state'] | undefined {
  return instance.list().find((job) => job.id === id)?.state
}

describe('adding a batch to an idle queue', () => {
  it('leaves every repair waiting until the batch is finished', async () => {
    const { instance } = await runner()
    const batch = instance.beginBatch()

    const first = queue(instance, 'A')
    const second = queue(instance, 'B')
    await settle()

    // Both are in the list, and neither has been handed to ffmpeg.
    expect(instance.list()).toHaveLength(2)
    expect(stateOf(instance, first.id)).toBe('queued')
    expect(stateOf(instance, second.id)).toBe('queued')

    batch.finish()
    await settle()
    expect(stateOf(instance, first.id)).toBe('running')
    expect(stateOf(instance, second.id)).toBe('running')
  })

  it('still honours the limit once the batch is in', async () => {
    const { instance } = await runner(1)
    const batch = instance.beginBatch()
    const first = queue(instance, 'A')
    const second = queue(instance, 'B')

    batch.finish()
    await settle()
    expect(stateOf(instance, first.id)).toBe('running')
    expect(stateOf(instance, second.id)).toBe('queued')
  })

  it('releases the hold even when the batch was cancelled part-way', async () => {
    const { instance } = await runner()
    const batch = instance.beginBatch()
    const first = queue(instance, 'A')

    // What "Cancel all" does to a batch still arriving.
    instance.cancelAll()
    batch.finish()
    await settle()

    // The hold is gone, so a later repair is not stranded behind it.
    expect(stateOf(instance, first.id)).toBeUndefined()
    const later = queue(instance, 'B')
    await settle()
    expect(stateOf(instance, later.id)).toBe('running')
  })
})

describe('adding a batch to a queue that is already working', () => {
  it('does not hold up the repairs already running', async () => {
    const { instance } = await runner(2)

    const running = queue(instance, 'A')
    await settle()
    expect(stateOf(instance, running.id)).toBe('running')

    // A second batch arrives while that one works; the free slot is used
    // rather than held open until this batch finishes arriving.
    const batch = instance.beginBatch()
    const added = queue(instance, 'B')
    await settle()
    expect(stateOf(instance, added.id)).toBe('running')
    batch.finish()
  })
})
