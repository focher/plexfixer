import { describe, expect, it } from 'vitest'
import { formatAgo } from '@shared/time.js'
import { formatAudioCodec, formatBytes, formatVideoCodec } from '@shared/display.js'

describe('formatAgo', () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0)

  it('rounds down into the largest whole unit', () => {
    expect(formatAgo(now, now)).toBe('just now')
    expect(formatAgo(now - 59_000, now)).toBe('just now')
    expect(formatAgo(now - 60_000, now)).toBe('1 min ago')
    expect(formatAgo(now - 59 * 60_000, now)).toBe('59 min ago')
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(formatAgo(now - 49 * 3_600_000, now)).toBe('2 d ago')
  })

  it('treats a future timestamp as just now and a missing one as unknown', () => {
    expect(formatAgo(now + 5_000, now)).toBe('just now')
    expect(formatAgo(undefined, now)).toBe('—')
  })
})

describe('formatBytes', () => {
  it('picks the unit that reads best, in steps of 1024', () => {
    expect(formatBytes(0)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(789_009_900)).toBe('752 MB')
    expect(formatBytes(2.2 * 1024 ** 3)).toBe('2.2 GB')
  })
})

describe('formatVideoCodec', () => {
  it('uses the familiar name for common codecs', () => {
    expect(formatVideoCodec('h264')).toBe('H.264')
    expect(formatVideoCodec('hevc')).toBe('HEVC')
    expect(formatVideoCodec('mpeg2video')).toBe('MPEG-2')
  })

  it('uppercases anything else, and shows a dash with no video', () => {
    expect(formatVideoCodec('prores')).toBe('PRORES')
    expect(formatVideoCodec(undefined)).toBe('—')
  })
})

describe('formatAudioCodec', () => {
  it('uses the familiar name for common codecs', () => {
    expect(formatAudioCodec('eac3')).toBe('E-AC-3')
    expect(formatAudioCodec('truehd')).toBe('TrueHD')
    expect(formatAudioCodec('pcm_s24le')).toBe('PCM')
  })

  it('uppercases anything else, and shows a dash with no audio', () => {
    expect(formatAudioCodec('wmapro')).toBe('WMAPRO')
    expect(formatAudioCodec(undefined)).toBe('—')
  })
})
