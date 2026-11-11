/**
 * Mode resolution: which repair mode a file actually gets.
 *
 * The whole point of the feature is the nesting — a folder set one way with an
 * exception inside it — so most of these are about which of several overrides
 * wins, and about the near-misses that must not win.
 */

import { describe, expect, it } from 'vitest'
import { effectiveMode, findOverrideKey, repairModeFor, resolveMode } from '../src/shared/mode.js'
import type { ModeOverrides } from '../src/shared/types.js'

describe('resolveMode', () => {
  it('falls back to the default when nothing is set', () => {
    expect(resolveMode('/Media/Movies/Alien.mkv', {}, 'safe-remux')).toEqual({
      mode: 'safe-remux',
      source: 'default'
    })
  })

  it('takes a folder override for the files under it', () => {
    const overrides: ModeOverrides = { '/Media/Anime': 'force-transcode' }
    expect(resolveMode('/Media/Anime/Show/S01E01.mkv', overrides, 'safe-remux')).toEqual({
      mode: 'force-transcode',
      source: 'folder',
      from: '/Media/Anime'
    })
  })

  it('lets a file override its folder', () => {
    const overrides: ModeOverrides = {
      '/Media/Anime': 'force-transcode',
      '/Media/Anime/Show/S01E01.mkv': 'report'
    }
    expect(resolveMode('/Media/Anime/Show/S01E01.mkv', overrides, 'safe-remux')).toEqual({
      mode: 'report',
      source: 'file',
      from: '/Media/Anime/Show/S01E01.mkv'
    })
    // Its neighbour still follows the folder.
    expect(effectiveMode('/Media/Anime/Show/S01E02.mkv', overrides, 'safe-remux')).toBe('force-transcode')
  })

  it('takes the nearest folder when folders are nested', () => {
    const overrides: ModeOverrides = {
      '/Media': 'report',
      '/Media/Anime': 'force-transcode'
    }
    expect(resolveMode('/Media/Anime/Show/S01E01.mkv', overrides, 'safe-remux').from).toBe('/Media/Anime')
    expect(effectiveMode('/Media/Movies/Alien.mkv', overrides, 'safe-remux')).toBe('report')
  })

  it('does not let a folder claim a sibling that merely starts the same', () => {
    const overrides: ModeOverrides = { '/Media/Anime': 'force-transcode' }
    expect(effectiveMode('/Media/Anime2/Show.mkv', overrides, 'safe-remux')).toBe('safe-remux')
    // …and the folder itself, named exactly, still resolves.
    expect(effectiveMode('/Media/Anime', overrides, 'safe-remux')).toBe('force-transcode')
  })

  it('ignores a trailing separator on the stored key', () => {
    expect(effectiveMode('/Media/Anime/Show.mkv', { '/Media/Anime/': 'report' }, 'safe-remux')).toBe('report')
  })

  describe('Windows paths', () => {
    it('matches a folder set with either separator', () => {
      const overrides: ModeOverrides = { 'Z:\\TV Shows\\Ted Lasso': 'force-transcode' }
      expect(effectiveMode('Z:\\TV Shows\\Ted Lasso\\S1E1 - Pilot.m4v', overrides, 'safe-remux')).toBe(
        'force-transcode'
      )
      expect(effectiveMode('Z:/TV Shows/Ted Lasso/S1E1 - Pilot.m4v', overrides, 'safe-remux')).toBe('force-transcode')
    })

    it('ignores case, because Windows does', () => {
      const overrides: ModeOverrides = { 'z:\\tv shows': 'report' }
      expect(effectiveMode('Z:\\TV Shows\\Ted Lasso\\S1E1.m4v', overrides, 'safe-remux')).toBe('report')
    })

    it('still treats case as meaningful on a POSIX path', () => {
      expect(effectiveMode('/Media/anime/Show.mkv', { '/Media/Anime': 'report' }, 'safe-remux')).toBe('safe-remux')
    })
  })
})

describe('findOverrideKey', () => {
  it('finds the stored key for a path spelt differently', () => {
    const overrides: ModeOverrides = { 'Z:\\TV Shows': 'report' }
    expect(findOverrideKey('z:/TV Shows/', overrides)).toBe('Z:\\TV Shows')
  })

  it('does not return an ancestor', () => {
    expect(findOverrideKey('/Media/Anime/Show.mkv', { '/Media/Anime': 'report' })).toBeUndefined()
  })
})

describe('repairModeFor', () => {
  const overrides: ModeOverrides = {
    '/Media/Anime': 'report',
    '/Media/Movies': 'safe-remux'
  }

  it('uses the file’s own mode when no mode is forced', () => {
    expect(repairModeFor('/Media/Movies/Alien.mkv', overrides, 'force-transcode')).toBe('safe-remux')
    expect(repairModeFor('/Media/Other/Alien.mkv', overrides, 'force-transcode')).toBe('force-transcode')
  })

  it('lets an explicit mode win over the file’s own', () => {
    expect(repairModeFor('/Media/Movies/Alien.mkv', overrides, 'safe-remux', 'force-transcode')).toBe(
      'force-transcode'
    )
  })

  it('never writes to a file set to report-only, however the repair was started', () => {
    expect(repairModeFor('/Media/Anime/Show.mkv', overrides, 'safe-remux', 'force-transcode')).toBe('report')
    expect(repairModeFor('/Media/Anime/Show.mkv', overrides, 'safe-remux', 'safe-remux')).toBe('report')
  })
})
