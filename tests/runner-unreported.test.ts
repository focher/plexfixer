/**
 * A repair that throws where nothing was expecting it to.
 *
 * This is the bug the diagnostics were built to find, and it was worse than
 * the thing it looked like. A Dolby Vision conversion with no dovi_tool to run
 * threw before the handler that would have caught it. The queue did everything
 * right — it freed the slot and started the next one — but nothing ever told
 * the row, so it went on saying "Queued" for good. Eight files were picked,
 * seven died in a millisecond each, and what was left was one repair running
 * and seven rows that looked like they were waiting their turn behind it.
 *
 * So the rule under test is not about Dolby Vision. It is that a repair either
 * reports what became of it or the queue reports it for them, whatever the
 * reason, and that a slot is never left looking occupied by a job that is
 * already dead.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '../src/shared/plex/analyze.js'
import { RepairRunner } from '@shared/plex/runner.js'
import type { AppSettings, Job } from '../src/shared/types.js'
import { localHost } from './node-host.js'
import { mainAudio, mkv, video } from './fixtures.js'

/** Convert profile 7, which is what the report that prompted this was doing. */
const CONVERT_DV7: AppSettings = { ...DEFAULT_SETTINGS, dolbyVision7: 'profile8' }

let dir: string
let made: RepairRunner[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-unreported-'))
  made = []
})
afterEach(async () => {
  for (const instance of made) instance.cancelAll()
  await rm(dir, { recursive: true, force: true })
})

/**
 * A runner with no dovi_tool, which is what every Windows build was.
 *
 * Not a contrivance: the binary failed to be placed during the build, the
 * failure was swallowed because fetching it is allowed to fail a release, and
 * so the app shipped without it. Every profile 7 film then threw from the
 * conversion step — which sits before the handler that catches a repair's
 * failures, and so was caught by nothing at all.
 */
function runner(concurrency = 2): { instance: RepairRunner; updates: Job[] } {
  const updates: Job[] = []
  const instance = new RepairRunner(
    // No `doviToolPath`, exactly as the Windows builds were resolved.
    { ffmpegPath: join(dir, 'ffmpeg'), ffprobePath: join(dir, 'ffprobe') },
    concurrency,
    (job) => updates.push(job),
    localHost()
  )
  made.push(instance)
  return { instance, updates }
}

/** A Dolby Vision profile 7 film, as a disc rip arrives. */
function queue(instance: RepairRunner, name: string): Job {
  return instance.enqueue({
    result: analyzeFile(
      mkv(
        [
          video({
            codec: 'hevc',
            profile: 'Main 10',
            bitDepth: 10,
            pixFmt: 'yuv420p10le',
            isHdr: true,
            dolbyVisionProfile: 7,
            frameRate: 23.976
          }),
          mainAudio({ index: 1, codec: 'aac' })
        ],
        { path: join(dir, 'Movies', name, `${name}.mkv`), fileName: `${name}.mkv` }
      ),
      CONVERT_DV7
    ),
    settings: CONVERT_DV7,
    mode: 'safe-remux'
  })
}

/** Wait for a job to stop being queued or running, rather than sleeping and hoping. */
async function settles(instance: RepairRunner, id: string, timeoutMs = 20_000): Promise<Job> {
  const started = Date.now()
  for (;;) {
    const job = instance.list().find((one) => one.id === id)
    if (job && job.state !== 'queued' && job.state !== 'running') return job
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waited ${timeoutMs}ms; ${id} is ${job?.state ?? 'not in the list'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('a repair that throws without reporting itself', () => {
  it('is marked failed rather than left saying it is queued', async () => {
    const { instance } = runner()
    const job = queue(instance, 'A')
    const settled = await settles(instance, job.id)
    expect(settled.state).toBe('failed')
    expect(settled.stage).toBe('finished')
  }, 30_000)

  it('says what went wrong, rather than failing with no message', async () => {
    const { instance } = runner()
    const job = queue(instance, 'A')
    const settled = await settles(instance, job.id)
    expect(settled.message).toContain('dovi_tool')
    // Said to somebody running the app, not building it.
    expect(settled.message).not.toContain('npm run')
    expect(settled.log.at(-1)?.level).toBe('error')
  }, 30_000)

  it('tells the window, so the row on screen changes too', async () => {
    const { instance, updates } = runner()
    const job = queue(instance, 'A')
    await settles(instance, job.id)
    expect(updates.some((update) => update.id === job.id && update.state === 'failed')).toBe(true)
  }, 30_000)

  it('does not strand the repairs behind it', async () => {
    /*
     * The shape of the real report: more files than slots, the early ones
     * dying instantly. Every one of them has to finish — the failure of one
     * must not leave a slot looking busy, which is what made a queue of eight
     * look like a queue of one.
     */
    const { instance } = runner(2)
    const jobs = ['A', 'B', 'C', 'D', 'E'].map((name) => queue(instance, name))
    const settled = await Promise.all(jobs.map((job) => settles(instance, job.id)))
    expect(settled.map((job) => job.state)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed'])
  }, 30_000)

  it('leaves a job that was cleared from the queue cleared', async () => {
    // A row removed by "Clear queue" must not come back as a failure: the
    // report is of something the user has already said they do not want.
    const { instance } = runner(1)
    const job = queue(instance, 'A')
    instance.clearQueued()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(instance.list().some((one) => one.id === job.id)).toBe(false)
  }, 30_000)
})
