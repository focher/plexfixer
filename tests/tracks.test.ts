import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { defaultAudioStream, resolvePrimaryLanguage, resolveTracks } from '@shared/plex/tracks.js'
import { audio, flags, mainAudio, mkv, subtitle, video } from './fixtures.js'

const settings = DEFAULT_SETTINGS

describe('resolvePrimaryLanguage', () => {
  it("uses the video track's own language tag when it has one", () => {
    const file = mkv([video({ language: 'jpn' }), audio({ index: 1, language: 'eng' })])
    expect(resolvePrimaryLanguage(file, settings)).toEqual({ language: 'jpn', source: 'video-stream-tag' })
  })

  it('falls back to the preferred language when an audio track carries it', () => {
    const file = mkv([video(), audio({ index: 1, language: 'jpn' }), audio({ index: 2, language: 'eng' })])
    expect(resolvePrimaryLanguage(file, settings)).toEqual({ language: 'eng', source: 'preferred-setting' })
  })

  it('uses a clear majority of audio tracks when the preferred language is absent', () => {
    const file = mkv([
      video(),
      audio({ index: 1, language: 'jpn' }),
      audio({ index: 2, language: 'jpn' }),
      audio({ index: 3, language: 'spa' })
    ])
    expect(resolvePrimaryLanguage(file, settings)).toEqual({ language: 'jpn', source: 'majority-audio' })
  })

  it('ignores commentary tracks when working out the majority', () => {
    const file = mkv([
      video(),
      audio({ index: 1, language: 'jpn' }),
      audio({ index: 2, language: 'spa', disposition: flags({ commentary: true }) }),
      audio({ index: 3, language: 'spa', title: 'Director Commentary' })
    ])
    expect(resolvePrimaryLanguage(file, settings).language).toBe('jpn')
  })
})

describe('resolveTracks — default audio', () => {
  it("moves the default flag to the track matching the video's language", () => {
    const file = mkv([
      video({ language: 'jpn' }),
      mainAudio({ index: 1, language: 'eng' }),
      audio({ index: 2, language: 'jpn' })
    ])
    const primary = resolvePrimaryLanguage(file, settings)
    const resolution = resolveTracks(file, settings, primary)

    expect(resolution.defaultAudioIndex).toBe(2)
    expect(resolution.defaultAudioLanguage).toBe('jpn')
    expect(resolution.findings.map((f) => f.code)).toContain('default-audio-language-mismatch')
    expect(resolution.changes).toContainEqual(
      expect.objectContaining({ streamIndex: 2, kind: 'audio', setDefault: true })
    )
    expect(resolution.changes).toContainEqual(
      expect.objectContaining({ streamIndex: 1, kind: 'audio', setDefault: false })
    )
  })

  it('clears every stray default when several are set', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      mainAudio({ index: 2, language: 'spa' })
    ])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))

    expect(resolution.findings.map((f) => f.code)).toContain('default-audio-multiple')
    expect(resolution.changes).toContainEqual(
      expect.objectContaining({ streamIndex: 2, setDefault: false })
    )
    expect(resolution.defaultAudioIndex).toBe(1)
  })

  it('never picks a commentary track as the default', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng', title: 'Commentary with the Director' }),
      audio({ index: 2, language: 'eng', channels: 6, channelLayout: '5.1' })
    ])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))
    expect(resolution.defaultAudioIndex).toBe(2)
  })

  it('prefers the surround track when several qualify equally', () => {
    const file = mkv([
      video({ language: 'eng' }),
      audio({ index: 1, language: 'eng', channels: 2 }),
      audio({ index: 2, language: 'eng', channels: 6, channelLayout: '5.1' })
    ])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))
    expect(resolution.defaultAudioIndex).toBe(2)
  })

  it('keeps an existing default that already qualifies', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng', channels: 2 }),
      audio({ index: 2, language: 'eng', channels: 6, channelLayout: '5.1' })
    ])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))
    expect(resolution.defaultAudioIndex).toBe(1)
    expect(resolution.changes.filter((c) => c.setDefault != null)).toHaveLength(0)
  })

  it('falls back to another language and says so when the primary one is absent', () => {
    const file = mkv([video({ language: 'jpn' }), audio({ index: 1, language: 'eng' })])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))
    expect(resolution.defaultAudioLanguage).toBe('eng')
    expect(resolution.findings.map((f) => f.code)).toContain('preferred-audio-language-absent')
  })
})

describe('resolveTracks — languages', () => {
  it('tags untagged tracks', () => {
    const file = mkv([video(), audio({ index: 1, language: 'und', rawLanguage: undefined })])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))

    expect(resolution.findings.map((f) => f.code)).toContain('language-missing')
    expect(resolution.changes).toContainEqual(expect.objectContaining({ streamIndex: 1, setLanguage: 'eng' }))
  })

  it('rewrites non-canonical tags to the ISO 639-2/B form', () => {
    const file = mkv([video(), audio({ index: 1, language: 'fre', rawLanguage: 'fra' })])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))

    expect(resolution.findings.map((f) => f.code)).toContain('language-nonstandard')
    expect(resolution.changes).toContainEqual(expect.objectContaining({ streamIndex: 1, setLanguage: 'fre' }))
  })
})

describe('resolveTracks — subtitles', () => {
  it('clears the default flag on image subtitles, which would force a burn-in', () => {
    const file = mkv([
      video({ language: 'eng' }),
      audio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', isImageBased: true, disposition: flags({ default: true }) })
    ])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))

    expect(resolution.findings.map((f) => f.code)).toContain('subtitle-image-default')
    expect(resolution.changes).toContainEqual(
      expect.objectContaining({ streamIndex: 2, kind: 'subtitle', setDefault: false })
    )
    expect(resolution.defaultSubtitleIndex).toBeUndefined()
  })

  it('defaults a full subtitle track when the audio is in another language', () => {
    const file = mkv([
      video({ language: 'jpn' }),
      audio({ index: 1, language: 'jpn' }),
      subtitle({ index: 2, language: 'eng' })
    ])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))
    expect(resolution.defaultSubtitleIndex).toBe(2)
  })

  it('prefers a forced track when the audio already matches', () => {
    const file = mkv([
      video({ language: 'eng' }),
      audio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, language: 'eng', title: 'Full' }),
      subtitle({ index: 3, language: 'eng', title: 'Forced (Signs)', disposition: flags({ forced: true }) })
    ])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))
    expect(resolution.defaultSubtitleIndex).toBe(3)
  })

  it('sets the forced flag on a track whose title says it is forced', () => {
    const file = mkv([
      video({ language: 'eng' }),
      audio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, language: 'eng', title: 'English (Forced)' })
    ])
    const resolution = resolveTracks(file, settings, resolvePrimaryLanguage(file, settings))

    expect(resolution.findings.map((f) => f.code)).toContain('forced-subtitle-not-flagged')
    expect(resolution.changes).toContainEqual(expect.objectContaining({ streamIndex: 2, setForced: true }))
  })
})

describe('defaultAudioStream', () => {
  it('picks the flagged track', () => {
    const file = mkv([video(), audio({ index: 1, codec: 'ac3' }), mainAudio({ index: 2, codec: 'truehd' })])
    expect(defaultAudioStream(file)?.index).toBe(2)
  })

  it('falls back to the first track, and to nothing with no audio', () => {
    expect(defaultAudioStream(mkv([video(), audio({ index: 1 }), audio({ index: 2 })]))?.index).toBe(1)
    expect(defaultAudioStream(mkv([video()]))).toBeUndefined()
  })
})
