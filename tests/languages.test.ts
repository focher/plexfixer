import { describe, expect, it } from 'vitest'
import { isUndefinedLanguage, languageName, normalizeLanguage, sameLanguage } from '@shared/languages.js'

describe('normalizeLanguage', () => {
  it('maps ISO 639-1 to 639-2/B', () => {
    expect(normalizeLanguage('en')).toBe('eng')
    expect(normalizeLanguage('ja')).toBe('jpn')
  })

  it('maps the terminological code to the bibliographic one', () => {
    // MP4 commonly stores "fra"/"deu"; Matroska and Plex expect "fre"/"ger".
    expect(normalizeLanguage('fra')).toBe('fre')
    expect(normalizeLanguage('deu')).toBe('ger')
    expect(normalizeLanguage('zho')).toBe('chi')
  })

  it('reduces BCP-47 tags to the primary subtag', () => {
    expect(normalizeLanguage('en-US')).toBe('eng')
    expect(normalizeLanguage('pt_BR')).toBe('por')
  })

  it('accepts English names', () => {
    expect(normalizeLanguage('English')).toBe('eng')
    expect(normalizeLanguage('japanese')).toBe('jpn')
  })

  it('treats missing and placeholder values as undefined', () => {
    expect(normalizeLanguage(undefined)).toBe('und')
    expect(normalizeLanguage('')).toBe('und')
    expect(normalizeLanguage('unknown')).toBe('und')
  })

  it('passes unknown codes through rather than destroying them', () => {
    expect(normalizeLanguage('qaa')).toBe('qaa')
  })
})

describe('language helpers', () => {
  it('compares across code forms', () => {
    expect(sameLanguage('fra', 'fre')).toBe(true)
    expect(sameLanguage('en-GB', 'eng')).toBe(true)
    expect(sameLanguage('eng', 'spa')).toBe(false)
  })

  it('treats zxx as carrying no language', () => {
    expect(isUndefinedLanguage('zxx')).toBe(true)
    expect(isUndefinedLanguage('eng')).toBe(false)
  })

  it('names known codes and falls back for unknown ones', () => {
    expect(languageName('ger')).toBe('German')
    expect(languageName('qaa')).toBe('QAA')
  })
})
