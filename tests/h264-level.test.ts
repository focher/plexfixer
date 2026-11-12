import { describe, expect, it } from 'vitest'
import { fitsH264Level, h264LevelLabel } from '@shared/plex/h264-level.js'
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

describe('h264LevelLabel', () => {
  it('formats a level_idc the way people and ffmpeg write it', () => {
    expect(h264LevelLabel(41)).toBe('4.1')
    expect(h264LevelLabel(30)).toBe('3.0')
  })
})
