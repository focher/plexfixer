import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import {
  audioCodecsOf,
  codecKey,
  countCodecs,
  emptyCodecFilter,
  filterByCodec,
  videoCodecOf,
  type CodecFilter
} from '@shared/plex/codecs.js'
import { audio, coverArt, mainAudio, mkv, video } from './fixtures.js'

const analyze = (file: Parameters<typeof analyzeFile>[0]) => analyzeFile(file, DEFAULT_SETTINGS)

const h264Aac = analyze(mkv([video({ codec: 'h264' }), mainAudio({ index: 1, codec: 'aac' })], { path: '/a.mkv' }))
const hevcDts = analyze(
  mkv(
    [video({ codec: 'hevc' }), mainAudio({ index: 1, codec: 'truehd' }), audio({ index: 2, codec: 'dts' })],
    { path: '/b.mkv' }
  )
)
const hevcAac = analyze(mkv([video({ codec: 'hevc' }), mainAudio({ index: 1, codec: 'aac' })], { path: '/c.mkv' }))
const all = [h264Aac, hevcDts, hevcAac]

const filter = (video: string[] = [], audio: string[] = []): CodecFilter => ({
  video: new Set(video),
  audio: new Set(audio)
})
const paths = (results: typeof all) => results.map((r) => r.file.path)

describe('codec keys', () => {
  it('collapses PCM variants and lowercases', () => {
    expect(codecKey('pcm_s24le')).toBe('pcm')
    expect(codecKey('HEVC')).toBe('hevc')
  })

  it('ignores cover art for the video codec', () => {
    const result = analyze(mkv([coverArt({ index: 0 }), video({ index: 1, codec: 'hevc' }), mainAudio({ index: 2 })]))
    expect(videoCodecOf(result)).toBe('hevc')
  })

  it('collects every audio track', () => {
    expect([...audioCodecsOf(hevcDts)].sort()).toEqual(['dts', 'truehd'])
  })
})

describe('filterByCodec', () => {
  it('returns the input unchanged with nothing ticked', () => {
    expect(filterByCodec(all, emptyCodecFilter())).toBe(all)
  })

  it('widens within a picker', () => {
    expect(paths(filterByCodec(all, filter(['h264', 'hevc'])))).toEqual(['/a.mkv', '/b.mkv', '/c.mkv'])
  })

  it('matches any audio track, not just the default', () => {
    expect(paths(filterByCodec(all, filter([], ['dts'])))).toEqual(['/b.mkv'])
  })

  it('narrows across pickers', () => {
    expect(paths(filterByCodec(all, filter(['hevc'], ['aac'])))).toEqual(['/c.mkv'])
  })
})

describe('countCodecs', () => {
  it('counts every codec with nothing ticked', () => {
    const counts = countCodecs(all, emptyCodecFilter())
    expect(Object.fromEntries(counts.video)).toEqual({ h264: 1, hevc: 2 })
    expect(Object.fromEntries(counts.audio)).toEqual({ aac: 2, truehd: 1, dts: 1 })
  })

  it("counts each picker against the other's selection only", () => {
    const counts = countCodecs(all, filter(['hevc'], ['aac']))
    // Video counts respect the AAC tick, not the HEVC one.
    expect(Object.fromEntries(counts.video)).toEqual({ h264: 1, hevc: 1 })
    // Audio counts respect the HEVC tick, not the AAC one.
    expect(Object.fromEntries(counts.audio)).toEqual({ aac: 1, truehd: 1, dts: 1 })
  })
})
