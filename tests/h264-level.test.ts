import { describe, expect, it } from 'vitest'
import { fitsH264Level, h264LevelFit, h264LevelLabel } from '@shared/plex/h264-level.js'
import { video } from './fixtures.js'

describe('fitsH264Level', () => {
  it('lets a small film labelled 4.2 be relabelled 4.1', () => {
    // "The Jackpot (1950)": 640×480 at 23.976 fps, about 1 Mbps.
    const stream = video({ width: 640, height: 480, frameRate: 23.976, level: 42, bitRate: 1_045_737 })
    expect(fitsH264Level(stream, 42, 41)).toBe(true)
  })

  it('lets 1080p at film rate drop from 4.2 to 4.1', () => {
    expect(fitsH264Level(video({ level: 42, frameRate: 23.976 }), 42, 41)).toBe(true)
  })

  it('refuses 1080p60, which really needs 4.2', () => {
    expect(fitsH264Level(video({ level: 42, frameRate: 59.94 }), 42, 41)).toBe(false)
  })

  it('refuses 1080p at 5.1, whose reference buffer 4.1 cannot hold', () => {
    expect(fitsH264Level(video({ level: 51, frameRate: 23.976 }), 51, 41)).toBe(false)
  })

  it('refuses when it cannot be sure', () => {
    expect(fitsH264Level(video({ level: 42, frameRate: undefined }), 42, 41)).toBe(false)
    expect(fitsH264Level(video({ level: 42, isInterlaced: true }), 42, 41)).toBe(false)
    expect(fitsH264Level(video({ level: 42 }), 99, 41)).toBe(false)
  })

  it('needs a measured bitrate when the ceiling drops', () => {
    // 4.1 -> 4.0 drops the bitrate ceiling from 50 to 20 Mbps.
    expect(fitsH264Level(video({ level: 41, bitRate: undefined }), 41, 40)).toBe(false)
    expect(fitsH264Level(video({ level: 41, bitRate: 8_000_000 }), 41, 40)).toBe(true)
    expect(fitsH264Level(video({ level: 41, bitRate: 30_000_000 }), 41, 40)).toBe(false)
  })
})

describe('reference frames', () => {
  // Waterworld (1995): 1920×1040 at 23.976 fps, labelled 5.0. Level 4.1's
  // frame buffer holds 4 frames at that size (32768 ÷ 7800 macroblocks).
  const waterworld = { width: 1920, height: 1040, frameRate: 24000 / 1001, level: 50, bitRate: 2_046_634 }

  it('relabels a stream labelled 5.0 that really uses 4 reference frames', () => {
    // Refused before the count was read: 5.0 allows 14 at this size, so the
    // worst case never fit.
    expect(h264LevelFit(video({ ...waterworld, refFrames: 4 }), 50, 41)).toEqual({ fits: true })
  })

  it('refuses one that uses 5, and says so', () => {
    expect(h264LevelFit(video({ ...waterworld, refFrames: 5 }), 50, 41)).toEqual({
      fits: false,
      reason: 'uses 5 reference frames, and Level 4.1 allows 4 at 1920×1040'
    })
  })

  it('assumes the worst when the count could not be read', () => {
    const fit = h264LevelFit(video({ ...waterworld, refFrames: undefined }), 50, 41)
    expect(fit.fits).toBe(false)
    expect(fit.reason).toContain('could not be read')
  })

  it('names the limit a fast stream breaks', () => {
    expect(h264LevelFit(video({ level: 42, frameRate: 59.94, refFrames: 2 }), 42, 41).reason).toBe(
      'is 1920×1080 at 59.94 fps, faster than Level 4.1 decodes'
    )
  })
})

describe('h264LevelLabel', () => {
  it('formats a level_idc the way people and ffmpeg write it', () => {
    expect(h264LevelLabel(41)).toBe('4.1')
    expect(h264LevelLabel(30)).toBe('3.0')
  })
})
