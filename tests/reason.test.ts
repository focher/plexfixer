import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { summarizeReason } from '@shared/plex/reason.js'
import { mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

describe('summarizeReason', () => {
  it('says nothing is wrong when nothing is wrong', () => {
    const result = analyzeFile(
      mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: true }),
      DEFAULT_SETTINGS
    )

    expect(result.findings).toEqual([])
    const reason = summarizeReason(result)
    expect(reason.tone).toBe('ok')
    expect(reason.headline).toBe('Direct plays as-is')
    expect(reason.others).toBe(0)
  })

  it('leads with the blocker, not the first finding', () => {
    // The MKV container is noted first during analysis, but an undecodable
    // video codec is the reason this file actually fails.
    const result = analyzeFile(
      mkv([video({ codec: 'vc1', language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]),
      DEFAULT_SETTINGS
    )

    const reason = summarizeReason(result)
    expect(result.findings.length).toBeGreaterThan(1)
    expect(reason.headline).toMatch(/VC1/i)
    expect(reason.others).toBe(result.findings.length - 1)
  })

  it('reports a video re-encode as needing Force transcode', () => {
    const result = analyzeFile(
      mkv([video({ codec: 'vc1', language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]),
      DEFAULT_SETTINGS
    )

    expect(result.plan.requiresTranscode).toBe(true)
    expect(summarizeReason(result).tone).toBe('transcode')
    expect(summarizeReason(result).outcome).toBe('needs Force transcode')
  })

  it('reports a plain remux as fixed by remux', () => {
    const result = analyzeFile(
      mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: false }),
      DEFAULT_SETTINGS
    )

    expect(result.plan.strategy).toBe('remux')
    const reason = summarizeReason(result)
    expect(reason.tone).toBe('fix')
    expect(reason.outcome).toBe('fixed by remux')
  })

  it('names the added AAC track when that is the fix', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), mainAudio({ index: 1, codec: 'truehd', channels: 8, language: 'eng' })]),
      DEFAULT_SETTINGS
    )

    expect(result.plan.strategy).toBe('transcode-audio')
    expect(summarizeReason(result).outcome).toBe('fixed by remux + AAC')
  })

  it('prefers an unresolved finding over an equally severe one the plan fixes', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' }),
        subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', isImageBased: true, language: 'eng' })
      ]),
      DEFAULT_SETTINGS
    )

    const reason = summarizeReason(result)
    const lead = result.findings.find((f) => f.title === reason.headline)
    expect(lead).toBeDefined()
    // Whatever wins must be at least as severe as everything else.
    const rank = { blocker: 0, warning: 1, info: 2 } as const
    for (const finding of result.findings) {
      expect(rank[lead!.severity]).toBeLessThanOrEqual(rank[finding.severity])
    }
  })

  it('flags a blocker no plan can fix as manual', () => {
    // Dolby Vision profile 5 has no HDR10 base layer, so neither a remux nor a
    // re-encode produces something a non-DV client can show correctly.
    const result = analyzeFile(
      mkv([video({ dolbyVisionProfile: 5, language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]),
      DEFAULT_SETTINGS
    )

    expect(result.plan.unresolved.some((f) => f.severity === 'blocker')).toBe(true)
    const reason = summarizeReason(result)
    expect(reason.tone).toBe('manual')
    expect(reason.outcome).toBe('no automatic fix')
    expect(reason.detail).toContain('not fixed by the plan')
  })

  it('does not call a file manual over an info-level note', () => {
    // Anamorphic video is left unresolved on purpose — it is worth mentioning,
    // not worth re-encoding for, and it must not mask the fix that does happen.
    const result = analyzeFile(
      mkv([
        video({ isAnamorphic: true, sampleAspectRatio: '4:3', language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' })
      ]),
      DEFAULT_SETTINGS
    )

    expect(result.plan.unresolved.every((f) => f.severity === 'info')).toBe(true)
    expect(result.plan.unresolved.length).toBeGreaterThan(0)
    expect(summarizeReason(result).tone).toBe('fix')
  })

  it('puts every finding in the tooltip', () => {
    const result = analyzeFile(
      mkv([video({ codec: 'vc1', language: 'eng' }), mainAudio({ index: 1, codec: 'truehd', channels: 8 })]),
      DEFAULT_SETTINGS
    )

    const { detail } = summarizeReason(result)
    for (const finding of result.findings) {
      expect(detail).toContain(finding.title)
    }
  })
})
