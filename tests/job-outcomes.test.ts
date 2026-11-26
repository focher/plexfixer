import { describe, expect, it } from 'vitest'
import type { Job, JobOutcome, JobState } from '@shared/types.js'
import { settledCount, summarizeOutcomes } from '@shared/jobs.js'

let next = 0
function job(state: JobState, outcome?: JobOutcome): Job {
  next += 1
  return {
    id: `job-${next}`,
    sourcePath: `/m/${next}.mkv`,
    outputPath: `/m/${next}.mp4`,
    state,
    outcome,
    mode: 'safe-remux',
    queuedAt: 0,
    progress: { fraction: 0 },
    log: [],
    host: { kind: 'local', label: 'this machine' },
    strategy: 'remux'
  } as Job
}

describe('summarizeOutcomes', () => {
  it('says nothing about an empty queue', () => {
    expect(summarizeOutcomes([])).toEqual([])
  })

  /*
   * The point of the whole thing. These three rows all read `skipped`, and
   * before this they arrived as one number — which told somebody with a
   * forty-file run that thirty-nine were "skipped" and nothing about which of
   * them they could do something about.
   */
  it('tells the three kinds of skip apart', () => {
    const groups = summarizeOutcomes([
      job('skipped', 'already-right'),
      job('skipped', 'blocked'),
      job('skipped', 'needs-transcode')
    ])
    expect(groups.map((group) => [group.key, group.count])).toEqual([
      ['already-right', 1],
      ['blocked', 1],
      ['needs-transcode', 1]
    ])
  })

  it('counts a rename as a repair, because something did change', () => {
    const groups = summarizeOutcomes([job('done', 'repaired'), job('done', 'renamed')])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'repaired', count: 2, tone: 'ok' })
  })

  it('leaves out every group that nothing landed in', () => {
    const groups = summarizeOutcomes([job('done', 'repaired')])
    expect(groups.map((group) => group.key)).toEqual(['repaired'])
  })

  /*
   * A job that failed never reached the point of recording an outcome, so it
   * has none — and must still be counted once, under `failed`, rather than
   * falling through every group and vanishing.
   */
  it('counts a failure with no outcome exactly once', () => {
    const groups = summarizeOutcomes([job('failed'), job('cancelled')])
    expect(groups.map((group) => [group.key, group.count])).toEqual([
      ['failed', 1],
      ['cancelled', 1]
    ])
  })

  it('ignores what has not finished, so the line does not jump about mid-run', () => {
    const groups = summarizeOutcomes([job('running'), job('queued'), job('done', 'repaired')])
    expect(groups).toEqual([expect.objectContaining({ key: 'repaired', count: 1 })])
  })

  it('hands back a predicate that finds the rows it counted', () => {
    const blocked = job('skipped', 'blocked')
    const jobs = [job('done', 'repaired'), blocked]
    const group = summarizeOutcomes(jobs).find((entry) => entry.key === 'blocked')
    expect(jobs.filter((entry) => group?.matches(entry))).toEqual([blocked])
  })
})

describe('settledCount', () => {
  it('counts everything that has stopped', () => {
    expect(settledCount([job('running'), job('queued'), job('done', 'repaired'), job('failed')])).toBe(2)
  })
})
