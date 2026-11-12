import { describe, expect, it } from 'vitest'
import { analyzeFile } from '@shared/plex/analyze.js'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { blockedReasons, blockedSummary, isBlocked } from '@shared/plex/blocked.js'
import { fileStatus } from '@shared/plex/facets.js'
import { summarizeReason } from '@shared/plex/reason.js'
import { mainAudio, mp4, video } from './fixtures.js'

const clean = analyzeFile(mp4([video(), mainAudio({ codec: 'aac' })]), DEFAULT_SETTINGS)

const dolbyVision = analyzeFile(
  mp4([video({ codec: 'hevc', codecTag: 'hvc1', dolbyVisionProfile: 5 }), mainAudio({ codec: 'aac' })]),
  DEFAULT_SETTINGS
)

// Faststart off as well, so this file has a blocker the plan *does* fix
// alongside the ceiling warning it does not.
const tooTall = analyzeFile(
  mp4([video({ width: 3840, height: 2160 }), mainAudio({ codec: 'aac' })], { faststart: false }),
  { ...DEFAULT_SETTINGS, maxHeight: 1080 }
)

describe('isBlocked', () => {
  it('is false for a file the plan fully handles', () => {
    expect(isBlocked(clean)).toBe(false)
    expect(blockedReasons(clean)).toEqual([])
    expect(blockedSummary(clean)).toBeUndefined()
  })

  it('agrees with the status the table shows', () => {
    expect(isBlocked(dolbyVision)).toBe(true)
    expect(fileStatus(dolbyVision)).toBe('manual')
  })
})

describe('blockedReasons', () => {
  it('explains Dolby Vision in terms of what a re-encode would destroy', () => {
    const [reason] = blockedReasons(dolbyVision)
    expect(reason?.code).toBe('video-dolby-vision-profile')
    expect(reason?.why).toContain('RPU metadata')
    expect(reason?.youCan).toContain('dovi_tool')
  })

  it('tells the truth about the height ceiling: Force transcode will not clear it', () => {
    const reason = blockedReasons(tooTall).find((entry) => entry.code === 'video-resolution-high')
    expect(reason).toBeDefined()
    expect(reason?.why).toContain('Force transcode will not either')
    expect(reason?.youCan).toContain('Raise the height ceiling')
  })

  it('never leaves a blocking finding without an explanation', () => {
    for (const result of [dolbyVision, tooTall]) {
      for (const reason of blockedReasons(result)) {
        expect(reason.why.length).toBeGreaterThan(20)
        expect(reason.youCan.length).toBeGreaterThan(10)
      }
    }
  })

  it('summarises several reasons in one line', () => {
    const summary = blockedSummary(dolbyVision)
    expect(summary).toContain('Dolby Vision')
  })
})

describe('the Why column on a blocked file', () => {
  it('leads with what is blocking, not with a problem the repair already fixes', () => {
    // This file also has its MP4 index at the end, which the remux moves — and
    // which outranks the ceiling warning on severity alone.
    expect(tooTall.findings.some((finding) => finding.code === 'mp4-not-faststart')).toBe(true)
    expect(summarizeReason(tooTall).headline).toContain('exceeds the 1080p ceiling')
    expect(summarizeReason(tooTall).tone).toBe('manual')
  })
})
