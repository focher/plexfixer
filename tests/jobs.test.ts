/**
 * The queue's "Hide completed" switch.
 *
 * The whole question this answers is which states count as completed. "No
 * longer running" is the wrong answer: a failed repair has also stopped, and
 * it is the one row on that page worth reading. Hiding the successes must
 * never take a failure with them.
 */

import { describe, expect, it } from 'vitest'
import { countCompleted, isCompleted, visibleJobs, withQueuedOrder } from '@shared/jobs.js'
import type { Job, JobState } from '@shared/types.js'

function job(state: JobState, id: string = state): Job {
  return {
    id,
    sourcePath: `/library/${id}.mkv`,
    outputPath: `/library/${id}.mp4`,
    strategy: 'remux',
    mode: 'safe-remux',
    state,
    progress: { fraction: state === 'done' ? 1 : 0 },
    log: []
  }
}

const STATES: JobState[] = ['queued', 'running', 'done', 'failed', 'cancelled', 'skipped']

describe('which repairs count as completed', () => {
  it('counts the ones that succeeded', () => {
    expect(isCompleted('done')).toBe(true)
  })

  it('does not count a repair that stopped without succeeding', () => {
    for (const state of ['failed', 'cancelled', 'skipped'] as JobState[]) {
      expect(isCompleted(state)).toBe(false)
    }
  })

  it('does not count one that has not finished', () => {
    expect(isCompleted('queued')).toBe(false)
    expect(isCompleted('running')).toBe(false)
  })

  it('counts how many the switch would hide', () => {
    expect(countCompleted(STATES.map((state) => job(state)))).toBe(1)
    expect(countCompleted([job('done', 'a'), job('done', 'b'), job('failed')])).toBe(2)
    expect(countCompleted([])).toBe(0)
  })
})

describe('what the queue draws', () => {
  it('shows everything while the switch is off', () => {
    const jobs = STATES.map((state) => job(state))
    expect(visibleJobs(jobs, false).map((entry) => entry.state)).toEqual(STATES)
  })

  it('keeps a failure on screen when the switch is on', () => {
    const jobs = STATES.map((state) => job(state))
    expect(visibleJobs(jobs, true).map((entry) => entry.state)).toEqual([
      'queued',
      'running',
      'failed',
      'cancelled',
      'skipped'
    ])
  })

  it('keeps the order it was given', () => {
    const jobs = [job('done', 'first'), job('failed', 'second'), job('done', 'third'), job('queued', 'fourth')]
    expect(visibleJobs(jobs, true).map((entry) => entry.id)).toEqual(['second', 'fourth'])
  })

  it('can hide every row, which is what the empty message is for', () => {
    expect(visibleJobs([job('done', 'a'), job('done', 'b')], true)).toEqual([])
  })

  it('leaves the caller free to hold on to the list it passed', () => {
    const jobs = [job('done')]
    expect(visibleJobs(jobs, false)).not.toBe(jobs)
  })
})

/**
 * Putting the waiting repairs in a new order.
 *
 * The runner and the window both apply the same new order to the same list, by
 * this one rule — a disagreement between them shows up as a row that moved on
 * screen and not in the queue, or the reverse.
 */
describe('reordering the waiting repairs in the list', () => {
  const row = (id: string, state: JobState): Job => job(state, id)
  const waiting = (entry: Job): boolean => entry.state === 'queued'
  const ids = (rows: Job[]): string[] => rows.map((entry) => entry.id)

  it('deals the waiting rows into the places they already hold', () => {
    const rows = [row('run', 'running'), row('a', 'queued'), row('b', 'queued'), row('c', 'queued')]
    expect(ids(withQueuedOrder(rows, waiting, ['c', 'a', 'b']))).toEqual(['run', 'c', 'a', 'b'])
  })

  /**
   * A running repair is writing a file and a finished one is the record of
   * something that happened. Neither moves because something else did.
   */
  it('leaves every row that is not waiting exactly where it was', () => {
    const rows = [
      row('done', 'done'),
      row('a', 'queued'),
      row('run', 'running'),
      row('b', 'queued'),
      row('failed', 'failed')
    ]
    expect(ids(withQueuedOrder(rows, waiting, ['b', 'a']))).toEqual(['done', 'b', 'run', 'a', 'failed'])
  })

  it('changes nothing when the order is the one it already has', () => {
    const rows = [row('a', 'queued'), row('b', 'queued')]
    expect(ids(withQueuedOrder(rows, waiting, ['a', 'b']))).toEqual(['a', 'b'])
  })

  it('copies rather than reordering the list it was given', () => {
    const rows = [row('a', 'queued'), row('b', 'queued')]
    withQueuedOrder(rows, waiting, ['b', 'a'])
    expect(ids(rows)).toEqual(['a', 'b'])
  })

  /*
    The order and the list come from two places and can disagree — a repair
    can start, finish or be cancelled while a drag is still in the air. A
    disagreement is not an order to be applied, and guessing at one would move
    rows the user never touched.
  */
  it('refuses an order that names something not waiting', () => {
    const rows = [row('run', 'running'), row('a', 'queued'), row('b', 'queued')]
    expect(ids(withQueuedOrder(rows, waiting, ['run', 'a']))).toEqual(['run', 'a', 'b'])
  })

  it('refuses an order that is missing a waiting row, or has one too many', () => {
    const rows = [row('a', 'queued'), row('b', 'queued'), row('c', 'queued')]
    expect(ids(withQueuedOrder(rows, waiting, ['c', 'a']))).toEqual(['a', 'b', 'c'])
    expect(ids(withQueuedOrder(rows, waiting, ['c', 'b', 'a', 'd']))).toEqual(['a', 'b', 'c'])
  })

  it('refuses an order that names the same row twice', () => {
    const rows = [row('a', 'queued'), row('b', 'queued')]
    expect(ids(withQueuedOrder(rows, waiting, ['a', 'a']))).toEqual(['a', 'b'])
  })

  it('has nothing to do with a list that holds no waiting rows', () => {
    const rows = [row('done', 'done'), row('run', 'running')]
    expect(ids(withQueuedOrder(rows, waiting, []))).toEqual(['done', 'run'])
    expect(ids(withQueuedOrder([], waiting, []))).toEqual([])
  })
})
