/**
 * Facets drive the filter chips, so what matters is that a file lands in the
 * group a user would look for it in — and, just as much, that it does not land
 * in one it has no business in.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import {
  countFacets,
  countStatuses,
  facetsFor,
  fileStatus,
  filterResults,
  matchesStatus,
  STATUS_ORDER
} from '@shared/plex/facets.js'
import { audio, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

const analyze = (file: Parameters<typeof analyzeFile>[0], patch = {}) =>
  analyzeFile(file, { ...DEFAULT_SETTINGS, ...patch })

describe('facetsFor', () => {
  it('marks a clean file as direct play and nothing else', () => {
    const result = analyze(mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
    expect([...facetsFor(result)]).toEqual(['direct-play'])
  })

  it('separates a container change from the work inside it', () => {
    const result = analyze(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
    const facets = facetsFor(result)
    expect(facets.has('container')).toBe(true)
    expect(facets.has('remux-only')).toBe(true)
    expect(facets.has('direct-play')).toBe(false)
    expect(facets.has('transcode-video')).toBe(false)
  })

  it('reports a default-audio change on its own', () => {
    // Two English tracks, neither flagged default: the resolver picks one.
    const result = analyze(
      mp4([
        video({ index: 0, language: 'eng' }),
        audio({ index: 1, codec: 'aac', language: 'eng' }),
        audio({ index: 2, codec: 'aac', language: 'eng' })
      ])
    )
    expect(facetsFor(result).has('audio-default')).toBe(true)
  })

  it('does not call a retag a retag when the tag already matches', () => {
    const result = analyze(
      mp4([
        video({ index: 0, codec: 'hevc', codecTag: 'hvc1', profile: 'main 10', language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' })
      ]),
      { allowHevc: true }
    )
    expect(facetsFor(result).has('codec-tag')).toBe(false)
  })

  it('catches the retag that matters', () => {
    const result = analyze(
      mp4([
        video({ index: 0, codec: 'hevc', codecTag: 'hev1', profile: 'main 10', language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' })
      ]),
      { allowHevc: true }
    )
    const facets = facetsFor(result)
    expect(facets.has('codec-tag')).toBe(true)
    expect(facets.has('remux-only')).toBe(true)
  })

  it('marks a file no automatic plan can fix as needing you', () => {
    const result = analyze(
      mp4([
        video({ index: 0, codec: 'hevc', codecTag: 'drmi', language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' })
      ])
    )
    expect(facetsFor(result).has('blocked')).toBe(true)
  })

  it('marks a re-encode, and does not also call it remux-only', () => {
    const result = analyze(
      mp4([
        video({ index: 0, codec: 'h264', profile: 'high 10', bitDepth: 10, language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' })
      ])
    )
    const facets = facetsFor(result)
    expect(facets.has('transcode-video')).toBe(true)
    expect(facets.has('remux-only')).toBe(false)
  })

  it('finds image subtitles that have to be dropped on the way to MP4', () => {
    const result = analyze(
      mkv([
        video({ index: 0, language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' }),
        subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', language: 'eng' })
      ])
    )
    expect(facetsFor(result).has('drop-tracks')).toBe(true)
  })
})

describe('filterResults', () => {
  const clean = analyze(mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
  const remux = analyze(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
  const all = [clean, remux]

  it('returns everything when nothing is selected', () => {
    expect(filterResults(all, new Set())).toHaveLength(2)
  })

  it('narrows to one group', () => {
    expect(filterResults(all, new Set(['direct-play'] as const))).toEqual([clean])
  })

  it('unions the selected groups rather than intersecting them', () => {
    expect(filterResults(all, new Set(['direct-play', 'container'] as const))).toHaveLength(2)
  })

  it('counts each file once per facet it carries', () => {
    const counts = countFacets(all)
    expect(counts['direct-play']).toBe(1)
    expect(counts['remux-only']).toBe(1)
    expect(counts['transcode-video']).toBe(0)
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
