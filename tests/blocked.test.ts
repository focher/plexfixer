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
  it('explains why relabelling profile 5 is not a fix, and points at the one that is', () => {
    const [reason] = blockedReasons(dolbyVision)
    expect(reason?.code).toBe('video-dolby-vision-profile')
    // The trap this text exists to head off: a file rewritten as 8.1 looks
    // fixed and is not.
    expect(reason?.why).toContain('8.1')
    expect(reason?.why).toContain('re-encode')
    expect(reason?.youCan).toContain('HDR10')
  })

  it('does not block on a warning only a re-encode would clear', () => {
    // Over the height ceiling is advisory: the file still plays, and the plan
    // fixes what it can (the MP4 index) without blocking it.
    expect(tooTall.findings.some((finding) => finding.code === 'video-resolution-high')).toBe(true)
    expect(isBlocked(tooTall)).toBe(false)
    expect(blockedReasons(tooTall)).toEqual([])
    expect(fileStatus(tooTall)).toBe('fixable')
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
    // The MP4 index at the end is fixed by the remux; Dolby Vision profile 5
    // is not, and that is what the headline has to say.
    const both = analyzeFile(
      mp4([video({ codec: 'hevc', codecTag: 'hvc1', dolbyVisionProfile: 5 }), mainAudio({ codec: 'aac' })], {
        faststart: false
      }),
      DEFAULT_SETTINGS
    )
    expect(both.findings.some((finding) => finding.code === 'mp4-not-faststart')).toBe(true)
    expect(summarizeReason(both).headline).toBe(blockedReasons(both)[0]?.title)
    expect(summarizeReason(both).tone).toBe('manual')
  })

  it('agrees with the status column on an advisory warning', () => {
    expect(summarizeReason(tooTall).tone).not.toBe('manual')
  })
})
