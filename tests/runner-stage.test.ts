/**
 * What the queue is told while a repair runs.
 *
 * The indicator is only as honest as what the runner records, so this watches
 * the updates themselves: which step the job claims to be in, which machine it
 * says it is running on, and that every update carries a fresh timestamp —
 * which is what lets the queue tell a working repair from a silent one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '../src/shared/plex/analyze.js'
import { RepairRunner } from '../src/main/jobs/runner.js'
import { localHost } from '../src/main/host.js'
import type { Host } from '../src/main/host.js'
import type { Job } from '../src/shared/types.js'
import { mainAudio, mkv, video } from './fixtures.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-stage-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function slowFfmpeg(): Promise<string> {
  const path = join(dir, 'slow-ffmpeg.sh')
  // `exec`, so the signal reaches the sleep itself: a shell waiting on a child
  // leaves the child holding the pipes open, and the job would not report its
  // cancellation until that child exited on its own.
  await writeFile(path, '#!/bin/sh\nexec sleep 10\n')
  await chmod(path, 0o755)
  return path
}

const result = analyzeFile(
  mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'spa' })]),
  DEFAULT_SETTINGS
)

/** A host that claims to be somewhere else, without needing anywhere else. */
function pretendRemote(): Host {
  return { ...localHost(), kind: 'remote', label: 'plex@nas' }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('what a running job reports', () => {
  it('names the machine it is on and walks through the steps', async () => {
    const updates: Job[] = []
    const runner = new RepairRunner(
      { ffmpegPath: await slowFfmpeg(), ffprobePath: await slowFfmpeg() },
      1,
      (job) => updates.push(job),
      pretendRemote()
    )

    const queued = runner.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    expect(queued.stage).toBe('waiting')
    expect(queued.host).toEqual({ kind: 'remote', label: 'plex@nas' })

    await settle(250)
    const running = runner.list()[0]!
    expect(running.state).toBe('running')
    expect(running.stage).toBe('copying')
    expect(running.host?.label).toBe('plex@nas')

    // Reached in order, and nothing skipped on the way.
    const stages = updates.map((job) => job.stage)
    expect(stages.indexOf('connecting')).toBeGreaterThanOrEqual(0)
    expect(stages.indexOf('planning')).toBeGreaterThan(stages.indexOf('connecting'))
    expect(stages.indexOf('copying')).toBeGreaterThan(stages.indexOf('planning'))

    runner.cancelAll()
    runner.cancel(running.id)
    await settle(400)
  })

  it('stamps every update, so silence is measurable', async () => {
    const updates: Job[] = []
    const runner = new RepairRunner(
      { ffmpegPath: await slowFfmpeg(), ffprobePath: await slowFfmpeg() },
      1,
      (job) => updates.push(job)
    )
    const before = Date.now()
    runner.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'report' })
    await settle(100)

    expect(updates.length).toBeGreaterThan(0)
    for (const job of updates) {
      expect(job.updatedAt).toBeGreaterThanOrEqual(before)
      expect(job.updatedAt).toBeLessThanOrEqual(Date.now())
    }
  })

  it('leaves a cancelled job at the step it stopped in, not at the end', async () => {
    const runner = new RepairRunner(
      { ffmpegPath: await slowFfmpeg(), ffprobePath: await slowFfmpeg() },
      1,
      () => undefined
    )
    const job = runner.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    await settle(250)
    runner.cancel(job.id)
    await settle(600)

    const finished = runner.list().find((entry) => entry.id === job.id)
    expect(finished?.state).toBe('cancelled')
    expect(finished?.stage).toBe('copying')
  })

  it('marks a job that never ran as finished, with nothing to show', async () => {
    const runner = new RepairRunner({ ffmpegPath: 'x', ffprobePath: 'x' }, 1, () => undefined)
    const skipped = runner.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'report' })
    expect(skipped.state).toBe('skipped')
    expect(skipped.stage).toBe('finished')
    expect(skipped.host?.kind).toBe('local')
  })
})
