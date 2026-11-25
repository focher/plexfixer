/**
 * Deciding what the queue picks up next.
 *
 * A scan of a library queues things in the order it walked them, which is
 * nobody's order of preference. Moving a waiting repair up or down has to do
 * two things at once, and the second is easy to forget: change which repair is
 * started next, *and* change where its row sits — a repair that quietly
 * changed places in the queue while staying put on screen is a button that
 * appears to do nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '../src/shared/plex/analyze.js'
import { RepairRunner } from '@shared/plex/runner.js'
import { localHost } from './node-host.js'
import { mainAudio, mkv, video } from './fixtures.js'

let dir: string
let made: RepairRunner[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-order-'))
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

function fileNeedingRepair(name: string) {
  return analyzeFile(
    mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'spa' })], {
      path: join(dir, 'Movies', name, `${name}.mkv`),
      fileName: `${name}.mkv`
    }),
    DEFAULT_SETTINGS
  )
}

async function runner(concurrency = 1): Promise<RepairRunner> {
  const ffmpeg = await slowFfmpeg()
  const instance = new RepairRunner({ ffmpegPath: ffmpeg, ffprobePath: ffmpeg }, concurrency, () => undefined, localHost())
  made.push(instance)
  return instance
}

const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Queue several repairs at once, the way a scan does, and hold them there. */
function queueAll(instance: RepairRunner, names: string[]): Map<string, string> {
  const batch = instance.beginBatch()
  const ids = new Map<string, string>()
  for (const name of names) {
    const job = instance.enqueue({ result: fileNeedingRepair(name), settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
    ids.set(name, job.id)
  }
  batch.finish()
  return ids
}

/** The names in the order the list draws them. */
function rows(instance: RepairRunner, ids: Map<string, string>): string[] {
  const names = new Map([...ids].map(([name, id]) => [id, name]))
  return instance.list().map((job) => names.get(job.id) ?? job.id)
}

function waiting(instance: RepairRunner, ids: Map<string, string>): string[] {
  const names = new Map([...ids].map(([name, id]) => [id, name]))
  return instance.queuedOrder().map((id) => names.get(id) ?? id)
}

describe('moving a waiting repair', () => {
  it('changes which one the queue picks up next', async () => {
    const instance = await runner(1)
    const ids = queueAll(instance, ['A', 'B', 'C', 'D'])
    await settle()

    // A is running on the single slot; the rest are waiting in order.
    expect(instance.list().find((job) => job.id === ids.get('A'))?.state).toBe('running')
    expect(waiting(instance, ids)).toEqual(['B', 'C', 'D'])

    // Tonight's film is last. Move it to the front.
    expect(instance.moveQueued(ids.get('D')!, -1)).toBe(ids.get('C'))
    expect(instance.moveQueued(ids.get('D')!, -1)).toBe(ids.get('B'))
    expect(waiting(instance, ids)).toEqual(['D', 'B', 'C'])

    // And it is the one that starts when the slot frees up.
    instance.cancel(ids.get('A')!)
    await settle(150)
    expect(instance.list().find((job) => job.id === ids.get('D'))?.state).toBe('running')
    expect(instance.list().find((job) => job.id === ids.get('B'))?.state).toBe('queued')
  })

  it('moves the row with it', async () => {
    const instance = await runner(1)
    const ids = queueAll(instance, ['A', 'B', 'C', 'D'])
    await settle()
    expect(rows(instance, ids)).toEqual(['A', 'B', 'C', 'D'])

    instance.moveQueued(ids.get('D')!, -1)
    expect(rows(instance, ids)).toEqual(['A', 'B', 'D', 'C'])
    expect(waiting(instance, ids)).toEqual(['B', 'D', 'C'])

    instance.moveQueued(ids.get('B')!, 1)
    expect(rows(instance, ids)).toEqual(['A', 'D', 'B', 'C'])
    expect(waiting(instance, ids)).toEqual(['D', 'B', 'C'])
  })

  it('leaves the ends of the queue alone', async () => {
    const instance = await runner(1)
    const ids = queueAll(instance, ['A', 'B', 'C'])
    await settle()

    expect(instance.moveQueued(ids.get('B')!, -1)).toBeUndefined()
    expect(instance.moveQueued(ids.get('C')!, 1)).toBeUndefined()
    expect(rows(instance, ids)).toEqual(['A', 'B', 'C'])
  })

  it('refuses to move a repair that is already running', async () => {
    const instance = await runner(1)
    const ids = queueAll(instance, ['A', 'B'])
    await settle()

    expect(instance.moveQueued(ids.get('A')!, 1)).toBeUndefined()
    expect(rows(instance, ids)).toEqual(['A', 'B'])
  })

  it('refuses to move one that has finished, or one it has never heard of', async () => {
    const instance = await runner(1)
    const ids = queueAll(instance, ['A', 'B'])
    await settle()
    instance.cancel(ids.get('B')!)

    expect(instance.moveQueued(ids.get('B')!, -1)).toBeUndefined()
    expect(instance.moveQueued('no-such-job', -1)).toBeUndefined()
  })

  /**
   * The order is only about what has not started, so what has finished keeps
   * its place in the record regardless.
   */
  it('reorders around rows that are no longer waiting', async () => {
    const instance = await runner(1)
    const ids = queueAll(instance, ['A', 'B', 'C'])
    await settle()

    instance.moveQueued(ids.get('C')!, -1)
    expect(rows(instance, ids)).toEqual(['A', 'C', 'B'])
    // A is still running and still at the top of the list.
    expect(instance.list()[0]?.id).toBe(ids.get('A'))
  })
})
