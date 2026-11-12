import { describe, expect, it } from 'vitest'
import type { Job } from '@shared/types.js'
import { describeProgress, stalledSeconds, stepsFor } from '@shared/stages.js'

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    sourcePath: '/media/Movie.mkv',
    outputPath: '/media/Movie.mp4',
    strategy: 'remux',
    mode: 'safe-remux',
    state: 'running',
    progress: { fraction: 0.42 },
    log: [],
    stage: 'copying',
    host: { kind: 'remote', label: 'plex@nas' },
    ...overrides
  }
}

describe('stepsFor', () => {
  it('always draws the backbone, with the current step active', () => {
    const steps = stepsFor(job())
    expect(steps.map((step) => step.stage)).toEqual(['connecting', 'copying', 'verifying', 'promoting'])
    expect(steps.map((step) => step.state)).toEqual(['done', 'active', 'todo', 'todo'])
  })

  it('adds a step the job actually reached, in its place in the order', () => {
    const steps = stepsFor(job({ stage: 'finalising' }))
    expect(steps.map((step) => step.stage)).toEqual(['connecting', 'copying', 'finalising', 'verifying', 'promoting'])
    expect(steps.find((step) => step.stage === 'finalising')?.state).toBe('active')
    expect(steps.find((step) => step.stage === 'copying')?.state).toBe('done')
  })

  it('shows every step done once the repair finished', () => {
    const steps = stepsFor(job({ state: 'done', stage: 'finished' }))
    expect(steps.every((step) => step.state === 'done')).toBe(true)
  })

  it('does not claim steps a failed job never reached', () => {
    // The runner leaves a failed job at the step it died in.
    const steps = stepsFor(job({ state: 'failed', stage: 'copying' }))
    expect(steps.find((step) => step.stage === 'connecting')?.state).toBe('done')
    // Nothing from the copy onwards completed, and none of it pulses as if
    // it were still going.
    expect(steps.filter((step) => step.state === 'todo').map((step) => step.stage)).toEqual([
      'copying',
      'verifying',
      'promoting'
    ])
    expect(steps.some((step) => step.state === 'active')).toBe(false)
  })

  it('shows nothing for a job that never ran', () => {
    expect(stepsFor(job({ state: 'skipped', stage: 'finished' }))).toEqual([])
  })
})

describe('stalledSeconds', () => {
  const now = 1_000_000

  it('only speaks up for a running job that has gone quiet', () => {
    expect(stalledSeconds(job({ updatedAt: now - 2_000 }), now)).toBeUndefined()
    expect(stalledSeconds(job({ updatedAt: now - 45_000 }), now)).toBe(45)
    expect(stalledSeconds(job({ state: 'done', updatedAt: now - 45_000 }), now)).toBeUndefined()
    expect(stalledSeconds(job({ updatedAt: undefined }), now)).toBeUndefined()
  })
})

describe('describeProgress', () => {
  it('reads as a step, with the percentage only where there is one', () => {
    expect(describeProgress(job())).toBe('Copying 42%')
    expect(describeProgress(job({ stage: 'verifying' }))).toBe('Verifying')
    expect(describeProgress(job({ stage: 'connecting', progress: { fraction: 0 } }))).toBe('Connecting')
    expect(describeProgress(job({ state: 'queued', stage: 'waiting' }))).toBe('Waiting')
  })
})
