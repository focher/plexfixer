/**
 * Which release notes a run is shown.
 *
 * The rule is "once per version", and the interesting cases are the ones
 * either side of it: a machine that has never recorded a version, an update
 * that skipped a release, and a build whose notes nobody wrote.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  RELEASE_NOTES,
  compareVersions,
  latestNotes,
  notesSince,
  releaseUrl,
  type ReleaseNote
} from '@shared/release-notes.js'

/** A table to reason about, so the tests do not move when a release is added. */
const NOTES: ReleaseNote[] = ['0.3.0', '0.2.10', '0.2.9'].map((version) => ({
  version,
  headline: `${version} happened`,
  changes: [{ title: 'Something', body: 'changed.' }]
}))

const versions = (notes: ReleaseNote[]): string[] => notes.map((note) => note.version)

describe('comparing versions', () => {
  it('reads the parts as numbers rather than text', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1)
    expect(compareVersions('0.2.9', '0.2.10')).toBe(-1)
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
  })

  it('calls the same version the same', () => {
    expect(compareVersions('0.2.6', '0.2.6')).toBe(0)
  })

  it('ignores what a release suffix says', () => {
    expect(compareVersions('0.2.6-beta.1', '0.2.6')).toBe(0)
  })

  it('treats a missing part as zero', () => {
    expect(compareVersions('0.2', '0.2.0')).toBe(0)
    expect(compareVersions('0.2', '0.2.1')).toBe(-1)
  })

  it('does not throw on something it cannot read', () => {
    expect(compareVersions('nonsense', '0.0.0')).toBe(0)
  })
})

describe('what a run is shown', () => {
  it('shows nothing when this version has already been seen', () => {
    expect(notesSince('0.3.0', '0.3.0', NOTES)).toEqual([])
  })

  it('shows the release just installed', () => {
    expect(versions(notesSince('0.2.10', '0.3.0', NOTES))).toEqual(['0.3.0'])
  })

  it('shows every release that was skipped, newest first', () => {
    expect(versions(notesSince('0.2.8', '0.3.0', NOTES))).toEqual(['0.3.0', '0.2.10', '0.2.9'])
  })

  it('shows only the current release on a machine that has recorded none', () => {
    // A fresh install and an update from before this screen existed look the
    // same from here, and neither wants a history of releases they never ran.
    expect(versions(notesSince(undefined, '0.3.0', NOTES))).toEqual(['0.3.0'])
  })

  it('shows nothing at all when the running version has no notes', () => {
    expect(notesSince(undefined, '0.4.0', NOTES)).toEqual([])
    expect(notesSince('0.3.0', '0.4.0', NOTES)).toEqual([])
  })

  it('never mentions a version that is not running', () => {
    // Downgraded, or a build made before the newest entry was written.
    expect(versions(notesSince('0.2.8', '0.2.10', NOTES))).toEqual(['0.2.10', '0.2.9'])
  })

  it('is not fooled by a table written in the wrong order', () => {
    const muddled = [NOTES[2], NOTES[0], NOTES[1]]
    expect(versions(notesSince('0.2.8', '0.3.0', muddled))).toEqual(['0.3.0', '0.2.10', '0.2.9'])
  })
})

describe('asking for the notes', () => {
  it('gives the current release', () => {
    expect(versions(latestNotes('0.3.0', NOTES))).toEqual(['0.3.0'])
  })

  it('falls back to the newest notes the build has', () => {
    expect(versions(latestNotes('0.4.0', NOTES))).toEqual(['0.3.0'])
  })

  it('gives nothing when the build predates every entry', () => {
    expect(latestNotes('0.1.0', NOTES)).toEqual([])
  })
})

describe('the notes that ship', () => {
  it('has an entry for the version being built', () => {
    // The reminder that a release is not finished until its notes are written:
    // without this, a version bump ships a What's new screen that says nothing.
    const packageJson = fileURLToPath(new URL('../package.json', import.meta.url))
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }
    expect(versions(RELEASE_NOTES)).toContain(version)
  })

  it('is written newest first', () => {
    expect(versions(RELEASE_NOTES)).toEqual(versions([...RELEASE_NOTES].sort((a, b) => compareVersions(b.version, a.version))))
  })

  it('says something in every entry', () => {
    for (const note of RELEASE_NOTES) {
      expect(note.headline.length, note.version).toBeGreaterThan(0)
      expect(note.changes.length, note.version).toBeGreaterThan(0)
      for (const change of note.changes) {
        expect(change.title.length, `${note.version} ${change.title}`).toBeGreaterThan(0)
        expect(change.body.length, `${note.version} ${change.title}`).toBeGreaterThan(0)
      }
    }
  })

  it('links each release to its own page', () => {
    expect(releaseUrl('0.2.6')).toBe('https://github.com/focher/plexfixer/releases/tag/v0.2.6')
  })
})
