/**
 * The queue's "Hide completed" switch.
 *
 * The whole question this answers is which states count as completed. "No
 * longer running" is the wrong answer: a failed repair has also stopped, and
 * it is the one row on that page worth reading. Hiding the successes must
 * never take a failure with them.
 */

import { describe, expect, it } from 'vitest'
import { countCompleted, isCompleted, visibleJobs } from '@shared/jobs.js'
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
