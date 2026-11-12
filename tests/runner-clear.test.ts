/**
 * Clearing the queue.
 *
 * "Clear queue" takes out what has not started and nothing else: a running
 * repair is part-way through writing a file, and a finished one is the record
 * of what happened. The job that must never come back is a cleared one — the
 * queue has to forget it before its slot frees up, or it starts anyway.
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

/** One at a time, so the second repair enqueued is reliably still waiting. */
async function runner(concurrency = 1): Promise<{ instance: RepairRunner; updates: Job[] }> {
  const updates: Job[] = []
  const instance = new RepairRunner(
    { ffmpegPath: await slowFfmpeg(), ffprobePath: await slowFfmpeg() },
    concurrency,
    (job) => updates.push(job)
  )
  return { instance, updates }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('clearQueued', () => {
  it('removes what has not started and leaves the running repair alone', async () => {
    const { instance } = await runner()
    const running = instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    const waiting = instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    await settle(150)
    expect(instance.list().find((job) => job.id === running.id)?.state).toBe('running')
    expect(instance.list().find((job) => job.id === waiting.id)?.state).toBe('queued')

    expect(instance.clearQueued()).toBe(1)
    const ids = instance.list().map((job) => job.id)
    expect(ids).toContain(running.id)
    expect(ids).not.toContain(waiting.id)
  })

  it('never starts a job that was cleared, even once the slot frees up', async () => {
    const { instance, updates } = await runner()
    instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    const waiting = instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    await settle(150)

    instance.clearQueued()
    instance.cancel(instance.list()[0]?.id ?? '')
    await settle(600)

    expect(instance.list().map((job) => job.id)).not.toContain(waiting.id)
    expect(updates.some((job) => job.id === waiting.id && job.state === 'running')).toBe(false)
  })

  it('keeps finished jobs, which are the record of what happened', async () => {
    const { instance } = await runner()
    // Report-only jobs finish immediately without touching ffmpeg.
    const done = instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'report' })
    await settle(100)
    expect(instance.list().find((job) => job.id === done.id)?.state).toBe('skipped')

    expect(instance.clearQueued()).toBe(0)
    expect(instance.list().map((job) => job.id)).toContain(done.id)
  })
})

describe('clearFinished', () => {
  it('is the other half: finished go, running and queued stay', async () => {
    const { instance } = await runner()
    const done = instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'report' })
    const running = instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    const waiting = instance.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    await settle(150)

    instance.clearFinished()
    const ids = instance.list().map((job) => job.id)
    expect(ids).not.toContain(done.id)
    expect(ids).toEqual(expect.arrayContaining([running.id, waiting.id]))

    instance.cancelAll()
  })
})
