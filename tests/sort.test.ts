import { describe, expect, it } from 'vitest'
import type { AnalysisResult } from '@shared/types.js'
import { DEFAULT_SORT, nextSort, sortResults } from '@shared/sort.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { mainAudio, mkv, mp4, video } from './fixtures.js'

function result(overrides: {
  path: string
  sizeBytes?: number
  scannedAt?: number
  container?: 'mp4' | 'mkv'
}): AnalysisResult {
  const streams = [video({ language: 'eng' }), mainAudio({ codec: 'aac', language: 'eng' })]
  const build = overrides.container === 'mkv' ? mkv : mp4
  const file = build(streams, {
    path: overrides.path,
    fileName: overrides.path.split('/').pop() ?? overrides.path,
    sizeBytes: overrides.sizeBytes ?? 1_000_000
  })
  return { ...analyzeFile(file, DEFAULT_SETTINGS), scannedAt: overrides.scannedAt }
}

const big = result({ path: '/m/Zulu.mp4', sizeBytes: 9_000_000, scannedAt: 100 })
const small = result({ path: '/m/Alpha.mp4', sizeBytes: 2_000_000, scannedAt: 300 })
const middle = result({ path: '/m/Mike.mkv', sizeBytes: 5_000_000, scannedAt: 200, container: 'mkv' })

const all = [big, small, middle]
const names = (results: AnalysisResult[]): string[] => results.map((entry) => entry.file.fileName)

describe('sortResults', () => {
  it('sorts by file name, not by path', () => {
    expect(names(sortResults(all, DEFAULT_SORT))).toEqual(['Alpha.mp4', 'Mike.mkv', 'Zulu.mp4'])
    expect(names(sortResults(all, { key: 'name', direction: 'desc' }))).toEqual(['Zulu.mp4', 'Mike.mkv', 'Alpha.mp4'])
  })

  it('sorts by size and by when the file was scanned', () => {
    expect(names(sortResults(all, { key: 'size', direction: 'desc' }))).toEqual(['Zulu.mp4', 'Mike.mkv', 'Alpha.mp4'])
    expect(names(sortResults(all, { key: 'scanned', direction: 'desc' }))).toEqual(['Alpha.mp4', 'Mike.mkv', 'Zulu.mp4'])
  })

  it('orders plans from nothing-to-do to the most expensive', () => {
    // The MKV needs a remux; the two MP4s are already fine.
    expect(names(sortResults(all, { key: 'plan', direction: 'desc' }))[0]).toBe('Mike.mkv')
  })

  it('breaks ties on the full path, so the order never wobbles', () => {
    const a = result({ path: '/a/Same.mp4', sizeBytes: 1000 })
    const b = result({ path: '/b/Same.mp4', sizeBytes: 1000 })
    expect(sortResults([b, a], { key: 'size', direction: 'asc' }).map((r) => r.file.path)).toEqual([
      '/a/Same.mp4',
      '/b/Same.mp4'
    ])
  })

  it('leaves the input array alone', () => {
    const input = [...all]
    sortResults(input, { key: 'size', direction: 'asc' })
    expect(input).toEqual(all)
  })
})

describe('nextSort', () => {
  it('starts a new column at its natural end and flips the current one', () => {
    expect(nextSort({ key: 'name', direction: 'asc' }, 'size')).toEqual({ key: 'size', direction: 'desc' })
    expect(nextSort({ key: 'size', direction: 'desc' }, 'size')).toEqual({ key: 'size', direction: 'asc' })
    expect(nextSort({ key: 'size', direction: 'asc' }, 'name')).toEqual({ key: 'name', direction: 'asc' })
  })
})
