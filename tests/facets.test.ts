/**
 * The chips are the flags a file carries, and the tiles are the catalog's
 * status rules. What matters is that a file lands under the chip a user would
 * look for it under — and, just as much, not under one it has no business in.
 */

import { describe, expect, it } from 'vitest'
import { settingsWith } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import {
  countFlags,
  countStatuses,
  fileStatus,
  filterByFlags,
  flagsOf,
  matchesStatus,
  needsYou,
  STATUS_ORDER
} from '@shared/plex/facets.js'
import { audio, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

const analyze = (file: Parameters<typeof analyzeFile>[0], patch: Parameters<typeof settingsWith>[0] = {}) =>
  analyzeFile(file, settingsWith(patch))

describe('flagsOf', () => {
  it('gives a clean file no flags', () => {
    const result = analyze(mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
    expect(flagsOf(result)).toEqual([])
  })

  it('flags a file that is not in the target container', () => {
    const result = analyze(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
    expect(flagsOf(result)).toContain('container-not-mp4')
  })

  it('flags two default-less English tracks as missing a default', () => {
    const result = analyze(
      mp4([
        video({ index: 0, language: 'eng' }),
        audio({ index: 1, codec: 'aac', language: 'eng' }),
        audio({ index: 2, codec: 'aac', language: 'eng' })
      ])
    )
    expect(flagsOf(result)).toContain('default-audio-missing')
  })

  it('does not flag an HEVC tag that is already right', () => {
    const result = analyze(
      mp4([
        video({ index: 0, codec: 'hevc', codecTag: 'hvc1', profile: 'main 10', language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' })
      ]),
      { allowHevc: true }
    )
    expect(flagsOf(result)).not.toContain('video-hevc-wrong-tag')
  })

  it('flags the HEVC tag that matters', () => {
    const result = analyze(
      mp4([
        video({ index: 0, codec: 'hevc', codecTag: 'hev1', profile: 'main 10', language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' })
      ]),
      { allowHevc: true }
    )
    expect(flagsOf(result)).toContain('video-hevc-wrong-tag')
  })

  it('flags image subtitles on the way to MP4', () => {
    const result = analyze(
      mkv([
        video({ index: 0, language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' }),
        subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', language: 'eng' })
      ])
    )
    expect(flagsOf(result)).toContain('subtitle-image-based')
  })

  it('lists each flag once however many tracks raised it', () => {
    const result = analyze(
      mp4([video({ index: 0 }), audio({ index: 1, codec: 'aac' }), audio({ index: 2, codec: 'aac' })])
    )
    const flags = flagsOf(result)
    expect(new Set(flags).size).toBe(flags.length)
  })
})

describe('filterByFlags', () => {
  const clean = analyze(mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
  const remux = analyze(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
  const faststart = analyze(
    mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: false })
  )
  const all = [clean, remux, faststart]

  it('returns everything when nothing is selected', () => {
    expect(filterByFlags(all, new Set())).toHaveLength(3)
  })

  it('narrows to the files carrying one flag', () => {
    expect(filterByFlags(all, new Set(['container-not-mp4']))).toEqual([remux])
  })

  it('unions the selected flags rather than intersecting them', () => {
    expect(filterByFlags(all, new Set(['container-not-mp4', 'mp4-not-faststart']))).toEqual([remux, faststart])
  })

  it('counts each file once per flag it carries', () => {
    const counts = countFlags(all)
    expect(counts.get('container-not-mp4')).toBe(1)
    expect(counts.get('mp4-not-faststart')).toBe(1)
    expect(counts.has('video-codec-unsupported')).toBe(false)
  })
})

describe('fileStatus', () => {
  const clean = analyze(mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
  const remux = analyze(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
  const reencode = analyze(
    mp4([
      video({ index: 0, codec: 'h264', profile: 'high 10', bitDepth: 10, language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' })
    ])
  )
  // Dolby Vision profile 5 has no HDR10 base layer: no remux or re-encode fixes it.
  const manual = analyze(
    mkv([video({ dolbyVisionProfile: 5, language: 'eng' }), mainAudio({ index: 1, language: 'eng' })])
  )
  const all = [clean, remux, reencode, manual]

  it('names what happens next for each kind of file', () => {
    expect(fileStatus(clean)).toBe('passed')
    expect(fileStatus(remux)).toBe('fixable')
    expect(fileStatus(reencode)).toBe('reencode')
    expect(fileStatus(manual)).toBe('manual')
  })

  // Shaped like "Le Bal (1983)": the video track is tagged English, the only
  // audio is French. "No English audio track" has no automatic fix — either the
  // video tag is wrong or a dub is missing — so it is the user's call.
  const frenchOnly = (faststart: boolean) =>
    analyze(
      mp4(
        [video({ language: 'eng', rawLanguage: 'eng' }), mainAudio({ index: 1, language: 'fre', rawLanguage: 'fra' })],
        { faststart }
      )
    )

  it('needs you when a warning can only be settled by hand, even with nothing to do', () => {
    const result = frenchOnly(true)
    expect(result.findings.map((f) => f.code)).toContain('preferred-audio-language-absent')
    expect(result.plan.strategy).toBe('none')
    expect(fileStatus(result)).toBe('manual')
  })

  it('still needs you when a remux is planned alongside', () => {
    const result = frenchOnly(false)
    expect(result.plan.strategy).toBe('remux')
    expect(fileStatus(result)).toBe('manual')
  })

  it('passes a file whose only unresolved warning is an optional re-encode', () => {
    // e.g. "HEVC may not play on every client": advisory, nothing to decide.
    const advisory = {
      ...clean,
      verdict: 'warn' as const,
      plan: {
        ...clean.plan,
        unresolved: [
          { code: 'video-codec-limited' as const, severity: 'warning' as const, remedy: 'transcode' as const, title: 'HEVC', detail: '' }
        ]
      }
    }
    expect(fileStatus(advisory)).toBe('passed')
  })

  it('treats manual-remedy warnings and blockers as needing you, and nothing else', () => {
    const finding = (severity: 'blocker' | 'warning' | 'info', remedy: 'manual' | 'transcode' | 'lossless') =>
      ({ code: 'video-codec-limited', severity, remedy, title: '', detail: '' }) as const
    expect(needsYou(finding('blocker', 'transcode'))).toBe(true)
    expect(needsYou(finding('warning', 'manual'))).toBe(true)
    expect(needsYou(finding('warning', 'transcode'))).toBe(false)
    expect(needsYou(finding('info', 'manual'))).toBe(false)
  })

  it('matches the status the file has and no other', () => {
    for (const result of all) {
      expect(STATUS_ORDER.filter((status) => matchesStatus(result, status))).toEqual([fileStatus(result)])
    }
  })

  it('counts every file exactly once', () => {
    const counts = countStatuses(all)
    expect(counts).toEqual({ passed: 1, fixable: 1, reencode: 1, manual: 1 })
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(all.length)
  })
})
