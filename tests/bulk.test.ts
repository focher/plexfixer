import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { repairOutcomes, summarizeRepair } from '@shared/bulk.js'
import { mainAudio, mkv, mp4, video } from './fixtures.js'

const analyze = (file: Parameters<typeof analyzeFile>[0]) => analyzeFile(file, DEFAULT_SETTINGS)

// Direct plays as it is.
const clean = analyze(
  mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { path: '/lib/clean.mp4' })
)
// MKV to MP4: a lossless remux.
const remux = analyze(
  mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { path: '/lib/remux.mkv' })
)
// 10-bit H.264 has no stream-copy fix: only a re-encode.
const reencode = analyze(
  mkv([video({ language: 'eng', pixFmt: 'yuv420p10le', bitDepth: 10, profile: 'High 10' }), mainAudio({ index: 1, language: 'eng' })], {
    path: '/lib/show/reencode.mkv'
  })
)

describe('fixtures', () => {
  it('cover each outcome', () => {
    expect(clean.plan.strategy).toBe('none')
    expect(remux.plan.strategy).not.toBe('none')
    expect(remux.plan.requiresTranscode).toBe(false)
    expect(reencode.plan.requiresTranscode).toBe(true)
  })
})

describe('summarizeRepair', () => {
  const all = [clean, remux, reencode]

  it('splits a Force transcode batch by what happens to each file', () => {
    expect(summarizeRepair(all, {}, 'safe-remux', 'force-transcode')).toEqual({
      reencode: 1,
      lossless: 1,
      needsReencodeSkipped: 0,
      nothingToDo: 1,
      reportOnly: 0
    })
  })

  it('skips a needed re-encode under Force lossless remux', () => {
    const summary = summarizeRepair(all, {}, 'safe-remux', 'safe-remux')
    expect(summary.reencode).toBe(0)
    expect(summary.needsReencodeSkipped).toBe(1)
  })

  it('lets Report only win over an explicit Force transcode', () => {
    const summary = summarizeRepair(all, { '/lib/show/reencode.mkv': 'report' }, 'safe-remux', 'force-transcode')
    expect(summary.reencode).toBe(0)
    expect(summary.reportOnly).toBe(1)
  })

  it("uses each file's own mode when none is forced", () => {
    const summary = summarizeRepair(all, { '/lib/show': 'force-transcode' }, 'safe-remux')
    expect(summary.reencode).toBe(1)
    expect(summary.needsReencodeSkipped).toBe(0)
  })
})

describe('repairOutcomes', () => {
  const summary = { reencode: 3, lossless: 9, needsReencodeSkipped: 0, nothingToDo: 2, reportOnly: 0 }

  it('says what happens to each group, leaving out empty ones', () => {
    expect(repairOutcomes(summary)).toEqual([
      '3 files will have their video re-encoded. This is slow, and it is not lossless.',
      '9 files only need a lossless remux and will be remuxed, not re-encoded.',
      '2 files have nothing to do and will be skipped.'
    ])
  })

  it('counts one file as one file', () => {
    expect(repairOutcomes({ reencode: 1, lossless: 0, needsReencodeSkipped: 0, nothingToDo: 0, reportOnly: 0 })).toEqual([
      '1 file will have its video re-encoded. This is slow, and it is not lossless.'
    ])
  })

  it('says a file with nothing wrong may still be renamed, when a pattern is set', () => {
    const lines = repairOutcomes({ ...summary, nothingToDo: 1 }, true)
    expect(lines.at(-1)).toBe(
      '1 file has nothing to repair, and will only be renamed if the naming pattern asks for it.'
    )
  })

  it('has nothing to say about a run with nothing in it', () => {
    expect(repairOutcomes({ reencode: 0, lossless: 0, needsReencodeSkipped: 0, nothingToDo: 0, reportOnly: 0 })).toEqual([])
  })
})
