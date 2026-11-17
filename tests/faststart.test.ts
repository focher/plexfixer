/**
 * The gate for handing a repair to qt-faststart, which can move the MP4 index
 * and nothing else. Anything more in the plan has to go to ffmpeg, or that
 * part of the repair would be silently skipped.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { indexMoveMismatch, isIndexMoveOnly } from '@shared/plex/faststart.js'
import { mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

const analyze = (file: Parameters<typeof analyzeFile>[0], patch = {}) =>
  analyzeFile(file, { ...DEFAULT_SETTINGS, ...patch })

/** A file whose only fault is the index at the end. */
const indexAtEnd = (overrides = {}) =>
  mp4([video({ index: 0, language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], {
    faststart: false,
    ...overrides
  })

describe('isIndexMoveOnly', () => {
  it('is true when the index is all that needs moving', () => {
    const result = analyze(indexAtEnd())
    expect(result.plan.strategy).toBe('remux')
    expect(result.plan.trackChanges).toEqual([])
    expect(isIndexMoveOnly(result)).toBe(true)
  })

  it('is false when the index is already at the front', () => {
    expect(isIndexMoveOnly(analyze(indexAtEnd({ faststart: true })))).toBe(false)
  })

  it('is false when the index position is unknown', () => {
    expect(isIndexMoveOnly(analyze(indexAtEnd({ faststart: undefined })))).toBe(false)
  })

  it('is false for Matroska, which is rewrapped rather than moved', () => {
    const result = analyze(mkv([video({ index: 0, language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
    expect(isIndexMoveOnly(result)).toBe(false)
  })

  it('is false when a language also changes', () => {
    const result = analyze(
      mp4([video({ index: 0, language: 'eng' }), mainAudio({ index: 1, language: 'und' })], { faststart: false }),
      { defaultLanguage: 'eng' }
    )
    expect(result.plan.trackChanges.length).toBeGreaterThan(0)
    expect(isIndexMoveOnly(result)).toBe(false)
  })

  it('is false when a subtitle flag also changes', () => {
    const result = analyze(
      mp4(
        [
          video({ index: 0, language: 'eng' }),
          mainAudio({ index: 1, language: 'eng' }),
          subtitle({ index: 2, codec: 'mov_text', language: 'eng', title: 'Forced' })
        ],
        { faststart: false }
      )
    )
    expect(result.plan.trackChanges.length).toBeGreaterThan(0)
    expect(isIndexMoveOnly(result)).toBe(false)
  })

  it('is false when the codec tag also changes (hev1 to hvc1)', () => {
    const result = analyze(
      mp4([video({ index: 0, language: 'eng', codec: 'hevc', profile: 'Main', codecTag: 'hev1' }), mainAudio({ index: 1, language: 'eng' })], {
        faststart: false
      }),
      { allowHevc: true }
    )
    expect(result.plan.videoCodecTag).toBe('hvc1')
    expect(isIndexMoveOnly(result)).toBe(false)
  })

  it('is true for HEVC that already carries hvc1', () => {
    const result = analyze(
      mp4([video({ index: 0, language: 'eng', codec: 'hevc', profile: 'Main', codecTag: 'hvc1' }), mainAudio({ index: 1, language: 'eng' })], {
        faststart: false
      }),
      { allowHevc: true }
    )
    expect(isIndexMoveOnly(result)).toBe(true)
  })

  it('is false when the H.264 level is relabelled', () => {
    const result = analyze(
      mp4(
        [
          video({ index: 0, language: 'eng', level: 50, refFrames: 4, bitRate: 2_000_000 }),
          mainAudio({ index: 1, language: 'eng' })
        ],
        { faststart: false }
      )
    )
    expect(result.plan.videoLevel).toBeDefined()
    expect(isIndexMoveOnly(result)).toBe(false)
  })

  it('is false when the video is re-encoded', () => {
    const result = analyze(
      mp4([video({ index: 0, language: 'eng', profile: 'High 10', bitDepth: 10 }), mainAudio({ index: 1, language: 'eng' })], {
        faststart: false
      })
    )
    expect(result.plan.videoTranscode).toBeDefined()
    expect(isIndexMoveOnly(result)).toBe(false)
  })
})

describe('indexMoveMismatch', () => {
  const source = indexAtEnd({ durationSeconds: 7200 })

  it('accepts the same streams with the index at the front', () => {
    expect(indexMoveMismatch(source, { ...source, faststart: true })).toBeUndefined()
  })

  it('rejects an output whose index is still at the end', () => {
    expect(indexMoveMismatch(source, { ...source, faststart: false })).toContain('not at the front')
  })

  it('rejects an output that lost a stream', () => {
    const output = { ...source, faststart: true, streams: source.streams.slice(0, 1) }
    expect(indexMoveMismatch(source, output)).toContain('streams')
  })

  it('rejects an output that is shorter than the original', () => {
    expect(indexMoveMismatch(source, { ...source, faststart: true, durationSeconds: 3600 })).toContain('runs')
  })
})
