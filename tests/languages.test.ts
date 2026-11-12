import { describe, expect, it } from 'vitest'
import {
  isCanonicalFor,
  isUndefinedLanguage,
  languageForContainer,
  languageName,
  normalizeLanguage,
  sameLanguage
} from '@shared/languages.js'

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

describe('languageForContainer', () => {
  it('writes ISO 639-2/T into MP4, where it differs from /B', () => {
    // mdhd is specified as /T; Apple players read "fre" in an MP4 as unknown.
    expect(languageForContainer('fre', 'mp4')).toBe('fra')
    expect(languageForContainer('ger', 'mp4')).toBe('deu')
    expect(languageForContainer('fra', 'mp4')).toBe('fra')
  })

  it('writes ISO 639-2/B into Matroska', () => {
    expect(languageForContainer('fra', 'mkv')).toBe('fre')
    expect(languageForContainer('deu', 'mkv')).toBe('ger')
  })

  it('leaves languages with a single code alone', () => {
    expect(languageForContainer('eng', 'mp4')).toBe('eng')
    expect(languageForContainer('eng', 'mkv')).toBe('eng')
  })

  it('passes unknown codes and und through', () => {
    expect(languageForContainer('qaa', 'mp4')).toBe('qaa')
    expect(languageForContainer('und', 'mp4')).toBe('und')
  })
})

describe('isCanonicalFor', () => {
  it('accepts only the form the container specifies', () => {
    expect(isCanonicalFor('fra', 'mp4')).toBe(true)
    expect(isCanonicalFor('fre', 'mp4')).toBe(false)
    expect(isCanonicalFor('fre', 'matroska')).toBe(true)
    expect(isCanonicalFor('fra', 'matroska')).toBe(false)
    expect(isCanonicalFor('eng', 'mp4')).toBe(true)
  })

  it('accepts either form in a container that specifies neither', () => {
    expect(isCanonicalFor('fra', 'other')).toBe(true)
    expect(isCanonicalFor('fre', 'other')).toBe(true)
  })

  it('rejects tags that are not three-letter codes, and ignores case', () => {
    expect(isCanonicalFor('en-US', 'mp4')).toBe(false)
    expect(isCanonicalFor('English', 'matroska')).toBe(false)
    expect(isCanonicalFor('FRA', 'mp4')).toBe(true)
  })

  it('leaves an unknown three-letter code alone', () => {
    expect(isCanonicalFor('qaa', 'mp4')).toBe(true)
  })
})
