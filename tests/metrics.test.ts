import { describe, expect, it } from 'vitest'
import type { JobMetrics } from '@shared/types.js'
import { diagnoseMetrics, formatMs, metricsLines, realtimeFactor, summarizeMetrics } from '@shared/metrics.js'

const base: JobMetrics = {
  sourceBytes: 6 * 1024 * 1024 * 1024,
  outputBytes: 6 * 1024 * 1024 * 1024,
  durationSeconds: 7200,
  mbPerSecond: 120,
  phases: [
    { phase: 'in-place-check', ms: 40 },
    { phase: 'ffmpeg', ms: 52_000 },
    { phase: 'verify', ms: 900 },
    { phase: 'promote', ms: 60 },
    { phase: 'total', ms: 53_200 }
  ]
}

describe('formatMs', () => {
  it('scales the unit to the size of the number', () => {
    expect(formatMs(42)).toBe('42ms')
    expect(formatMs(1500)).toBe('1.5s')
    expect(formatMs(62_000)).toBe('1m 02s')
    expect(formatMs(3_900_000)).toBe('1h 05m')
  })
})

describe('summarizeMetrics', () => {
  it('reads as time, rate and realtime multiple', () => {
    expect(summarizeMetrics(base)).toBe('53.2s · 120 MB/s · 138x realtime')
  })

  it('says nothing when the repair was never measured', () => {
    expect(summarizeMetrics(undefined)).toBeUndefined()
    expect(summarizeMetrics({ phases: [] })).toBeUndefined()
  })
})

describe('realtimeFactor', () => {
  it('needs both a duration and an ffmpeg phase', () => {
    expect(realtimeFactor({ phases: [{ phase: 'ffmpeg', ms: 1000 }] })).toBeUndefined()
    expect(realtimeFactor({ durationSeconds: 60, phases: [{ phase: 'ffmpeg', ms: 1000 }] })).toBe('60x realtime')
  })
})

describe('diagnoseMetrics', () => {
  it('blames the network when the slow volume is a network mount', () => {
    const notes = diagnoseMetrics({
      ...base,
      mbPerSecond: 22,
      source: { kind: 'network', mount: '/Volumes/Media', filesystem: '//tim@nas/Media' }
    })
    expect(notes[0]).toContain('22 MB/s across a network mount')
    expect(notes[0]).toContain('/Volumes/Media')
  })

  it('does not blame the network for a slow local disk', () => {
    const notes = diagnoseMetrics({ ...base, mbPerSecond: 18, source: { kind: 'local', mount: '/' } })
    expect(notes[0]).toContain('slow for a local disk')
  })

  it('calls out an index move that dominates the run', () => {
    const notes = diagnoseMetrics({
      ...base,
      phases: [...base.phases, { phase: 'finalise', ms: 26_000 }]
    })
    expect(notes.some((note) => note.includes('index to the front'))).toBe(true)
  })

  it('explains a slow promote by the volume it had to cross', () => {
    const notes = diagnoseMetrics({
      ...base,
      sameVolume: false,
      phases: [...base.phases.filter((p) => p.phase !== 'promote'), { phase: 'promote', ms: 30_000 }]
    })
    expect(notes.some((note) => note.includes('crossed volumes'))).toBe(true)
  })

  it('says nothing about throughput for a file too small to judge it by', () => {
    // 40 KB in 200ms is 0.2 MB/s, and it means nothing: it is process startup.
    const tiny = {
      ...base,
      sourceBytes: 41_000,
      outputBytes: 41_000,
      mbPerSecond: 0.2,
      phases: [
        { phase: 'ffmpeg' as const, ms: 45 },
        { phase: 'verify' as const, ms: 76 },
        { phase: 'total' as const, ms: 198 }
      ]
    }
    expect(diagnoseMetrics(tiny)).toEqual([])
  })

  it('falls back to saying the time was ffmpeg, when nothing else stands out', () => {
    const notes = diagnoseMetrics(base)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('ffmpeg itself')
  })
})

describe('metricsLines', () => {
  it('lists the stages longest first with their share of the total', () => {
    const lines = metricsLines(base)
    expect(lines[0]).toBe('total          53.2s')
    const stages = lines.slice(lines.indexOf('Stages:') + 1)
    expect(stages[0]).toContain('ffmpeg')
    expect(stages[0]).toContain('98%')
    expect(stages[stages.length - 1]).toContain('Checked for an in-place edit')
  })
})
