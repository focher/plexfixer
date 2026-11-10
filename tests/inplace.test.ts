/**
 * The gate that decides a repair can be written into the file instead of
 * copying it. Being wrong here means editing someone's media in place, so
 * what matters most is that everything else is refused.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { inPlaceVerdict } from '@shared/plex/inplace.js'
import { audio, coverArt, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

const analyze = (file: Parameters<typeof analyzeFile>[0], patch = {}) =>
  analyzeFile(file, { ...DEFAULT_SETTINGS, ...patch })

/** Two English audio tracks, neither default: a pure flag change. */
const defaultAudioOnly = () =>
  mp4(
    [
      video({ index: 0, language: 'eng' }),
      audio({ index: 1, codec: 'aac', language: 'eng' }),
      audio({ index: 2, codec: 'aac', language: 'eng' })
    ],
    { faststart: true }
  )

describe('inPlaceVerdict — what it allows', () => {
  it('allows a language rewrite', () => {
    const result = analyze(
      mp4(
        [
          video({ index: 0, language: 'eng' }),
          mainAudio({ index: 1, language: 'eng' }),
          subtitle({ index: 2, codec: 'mov_text', language: 'fre', rawLanguage: 'fra' })
        ],
        { faststart: true }
      )
    )
    const verdict = inPlaceVerdict(result)
    expect(verdict.refusal).toBeUndefined()
    expect(verdict.changes?.some((c) => c.setLanguage === 'fre')).toBe(true)
  })

  it('allows a default-flag change', () => {
    const verdict = inPlaceVerdict(analyze(defaultAudioOnly()))
    expect(verdict.refusal).toBeUndefined()
    expect(verdict.changes?.some((c) => c.setDefault != null)).toBe(true)
  })
})

describe('inPlaceVerdict — what it refuses', () => {
  const refusalFor = (file: Parameters<typeof analyzeFile>[0], patch = {}) =>
    inPlaceVerdict(analyze(file, patch)).refusal

  it('refuses a container change', () => {
    expect(
      refusalFor(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]))
    ).toBe('not-mp4')
  })

  it('refuses anything needing a re-encode', () => {
    // Refused as 'not-a-remux': the strategy is checked before the details.
    expect(
      refusalFor(
        mp4([
          video({ index: 0, codec: 'h264', profile: 'high 10', bitDepth: 10, language: 'eng' }),
          mainAudio({ index: 1, language: 'eng' })
        ])
      )
    ).toBe('not-a-remux')
  })

  it('refuses when the index has to move', () => {
    // Same file as the allowed language case, but the moov is at the end.
    const result = analyze(
      mp4(
        [
          video({ index: 0, language: 'eng' }),
          mainAudio({ index: 1, language: 'eng' }),
          subtitle({ index: 2, codec: 'mov_text', language: 'fre', rawLanguage: 'fra' })
        ],
        { faststart: false }
      )
    )
    expect(inPlaceVerdict(result).refusal).toBe('moves-the-index')
  })

  it('refuses a codec retag', () => {
    expect(
      refusalFor(
        mp4(
          [
            video({ index: 0, codec: 'hevc', codecTag: 'hev1', profile: 'main 10', language: 'eng' }),
            mainAudio({ index: 1, language: 'eng' })
          ],
          { faststart: true }
        ),
        { allowHevc: true }
      )
    ).toBe('changes-the-codec-tag')
  })

  it('refuses when a track is dropped', () => {
    const result = analyze(
      mp4(
        [
          video({ index: 0, language: 'eng' }),
          mainAudio({ index: 1, language: 'eng' }),
          subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', language: 'fre', rawLanguage: 'fra' })
        ],
        { faststart: true }
      )
    )
    expect(inPlaceVerdict(result).refusal).toBe('drops-a-track')
  })

  it('says there is nothing to do for a clean file', () => {
    expect(
      refusalFor(
        mp4([video({ index: 0, language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: true })
      )
    ).toBe('nothing-to-do')
  })

  it('refuses a file that only carries artwork changes', () => {
    // Artwork is a mapped track, not a metadata field.
    const result = analyze(
      mp4(
        [
          video({ index: 0, language: 'eng' }),
          mainAudio({ index: 1, language: 'eng' }),
          coverArt({ index: 2 })
        ],
        { faststart: true }
      )
    )
    expect(inPlaceVerdict(result).changes).toBeUndefined()
  })
})
