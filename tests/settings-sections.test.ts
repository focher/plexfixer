import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, sectionFrom } from '@shared/settings-sections.js'

describe('settings sections', () => {
  it('gives every section a unique id, a label and a hint', () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const section of SETTINGS_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0)
      expect(section.hint.length).toBeGreaterThan(0)
    }
  })

  it('opens on a section that exists', () => {
    expect(SETTINGS_SECTIONS.some((section) => section.id === DEFAULT_SETTINGS_SECTION)).toBe(true)
  })

  it('returns a remembered section unchanged', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(sectionFrom(section.id)).toBe(section.id)
    }
  })

  it('falls back when nothing was remembered', () => {
    expect(sectionFrom(null)).toBe(DEFAULT_SETTINGS_SECTION)
    expect(sectionFrom(undefined)).toBe(DEFAULT_SETTINGS_SECTION)
    expect(sectionFrom('')).toBe(DEFAULT_SETTINGS_SECTION)
  })

  it('falls back on a section that no longer exists, rather than showing an empty pane', () => {
    // A build that drops or renames a section leaves this behind in storage.
    expect(sectionFrom('subtitles')).toBe(DEFAULT_SETTINGS_SECTION)
    expect(sectionFrom('LANGUAGES')).toBe(DEFAULT_SETTINGS_SECTION)
  })
})
