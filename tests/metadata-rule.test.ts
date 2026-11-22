/**
 * The rule that notices a file saying nothing about itself.
 *
 * It ships switched off, so every test here turns it on first — which is
 * itself worth asserting, since a rule that fires on most of a library and
 * clears only by hand would be a poor thing to arrive switched on.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { metadataMissing } from '@shared/plex/modules/checks/metadata-missing.js'
import { isModuleEnabled } from '@shared/plex/modules/framework.js'
import type { AppSettings, MediaFile } from '@shared/types.js'
import { mainAudio, mp4, video } from './fixtures.js'

const on: AppSettings = { ...DEFAULT_SETTINGS, enabledModules: [metadataMissing.id] }

/** A file that plays perfectly; only its tags vary. */
function file(tags: Record<string, string>, overrides: Partial<MediaFile> = {}): MediaFile {
  return mp4([video(), mainAudio()], { tags, ...overrides })
}

const codes = (f: MediaFile, settings: AppSettings = on): string[] =>
  analyzeFile(f, settings).findings.map((finding) => finding.code)

describe('the metadata rule', () => {
  it('ships switched off', () => {
    expect(metadataMissing.startsOff).toBe(true)
    expect(isModuleEnabled(metadataMissing, DEFAULT_SETTINGS)).toBe(false)
    expect(codes(file({}), DEFAULT_SETTINGS)).not.toContain('metadata-missing')
  })

  it('reports a file carrying no tags at all', () => {
    expect(codes(file({}))).toContain('metadata-missing')
  })

  it('says nothing about a file that already states what it is', () => {
    expect(codes(file({ title: 'Example', date: '2020-01-01' }))).not.toContain('metadata-missing')
  })

  it('counts the file name in the title field as no title', () => {
    // What a ripper leaves behind. It is text in the right field and tells
    // you nothing you did not have from the name itself.
    const named = file({ title: 'Example (2020)', date: '2020' })
    expect(codes(named)).toContain('metadata-missing')
    // Punctuation and case are not the difference.
    expect(codes(file({ title: 'example.2020', date: '2020' }, { fileName: 'Example (2020).mp4' }))).toContain(
      'metadata-missing'
    )
  })

  it('counts a release string in the title field as no title', () => {
    expect(codes(file({ title: 'Heat 1080p BluRay x264', date: '1995' }))).toContain('metadata-missing')
  })

  it('reports a missing year on its own', () => {
    expect(codes(file({ title: 'Heat' }))).toContain('metadata-missing')
  })

  it('does not report a missing summary on its own', () => {
    // A summary is a nicety. A row for every file without a paragraph in it
    // would bury the files that have nothing at all.
    expect(codes(file({ title: 'Heat', date: '1995' }))).not.toContain('metadata-missing')
  })

  it('mentions the summary when something else is missing too', () => {
    const found = analyzeFile(file({ title: 'Heat' }), on).findings.find((f) => f.code === 'metadata-missing')
    expect(found?.detail).toContain('a summary')
    expect(found?.detail).toContain('a year')
  })

  it('does not change the verdict, the plan, or what is left unresolved', () => {
    // Embedded tags have nothing to do with direct play, and a rule that
    // quietly made a good file look bad would be worse than no rule.
    const bare = file({})
    const off = analyzeFile(bare, DEFAULT_SETTINGS)
    const lit = analyzeFile(bare, on)
    expect(lit.verdict).toBe(off.verdict)
    expect(lit.plan).toEqual(off.plan)
    expect(lit.plan.unresolved).toEqual([])
  })

  it('reads the tag whatever case the container wrote it in', () => {
    expect(codes(file({ TITLE: 'Heat', DATE: '1995' }))).not.toContain('metadata-missing')
  })
})
