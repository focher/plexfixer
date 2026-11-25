/**
 * Metadata set by hand.
 *
 * The only instruction this app takes rather than works out, so the tests are
 * about precedence and restraint: what a person says beats what a rule
 * decided, it does not quietly undo the rest of what that rule decided, and
 * nothing is rewritten for an edit that changes nothing.
 */

import { describe, expect, it } from 'vitest'
import { analyzeFile } from '@shared/plex/analyze.js'
import { episodeFieldsFor } from '@shared/plex/metadata.js'
import { inPlaceVerdict } from '@shared/plex/inplace.js'
import { buildRepairCommand } from '@shared/plex/command.js'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import {
  bareNumber,
  changesAnything,
  cleanTags,
  isEmptyEdit,
  tagsOf,
  type MetadataEdit
} from '@shared/plex/metadata.js'
import { audio, flags, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'
import type { MediaFile } from '@shared/types.js'

const settings = DEFAULT_SETTINGS

/** An ordinary MP4 with two audio tracks, the second of which is commentary. */
function film(): MediaFile {
  return mp4([
    video({ language: 'eng' }),
    mainAudio({ index: 1, language: 'eng', disposition: flags({ default: true }) }),
    audio({ index: 2, language: 'eng', title: 'Director commentary' })
  ])
}

describe('reading what a file already says', () => {
  it('picks the tags that can be changed, whatever case they are stored in', () => {
    const file = mp4([video()], { tags: { Title: 'Heat', ENCODER: 'x264', date: '1995' } })
    expect(tagsOf(file)).toEqual({ title: 'Heat', date: '1995' })
  })
})

describe('what counts as an edit', () => {
  it('drops blanks and anything not on the list', () => {
    expect(cleanTags({ title: ' Heat ', genre: '  ', nonsense: 'x' })).toEqual({ title: 'Heat' })
  })

  it('knows an edit that asks for nothing', () => {
    expect(isEmptyEdit(undefined)).toBe(true)
    expect(isEmptyEdit({ tags: { title: '  ' } })).toBe(true)
    expect(isEmptyEdit({ tracks: { 1: {} } })).toBe(true)
    expect(isEmptyEdit({ tracks: { 1: { default: false } } })).toBe(false)
  })

  it('knows an edit that asks for what the file already says', () => {
    const file = mp4([video({ language: 'eng' })], { tags: { title: 'Heat' } })
    expect(changesAnything({ tags: { title: 'Heat' } }, file)).toBe(false)
    expect(changesAnything({ tags: { title: 'Heat ' } }, file)).toBe(false)
    expect(changesAnything({ tags: { title: 'Collateral' } }, file)).toBe(true)
  })

  it('knows a track edit that changes nothing', () => {
    const file = film()
    expect(changesAnything({ tracks: { 1: { default: true } } }, file)).toBe(false)
    expect(changesAnything({ tracks: { 1: { default: false } } }, file)).toBe(true)
    expect(changesAnything({ tracks: { 2: { title: 'Director commentary' } } }, file)).toBe(false)
    expect(changesAnything({ tracks: { 2: { title: 'Commentary' } } }, file)).toBe(true)
  })
})

describe('planning an edit', () => {
  it('does nothing at all without one', () => {
    expect(analyzeFile(film(), settings).plan.metadataTags).toBeUndefined()
  })

  it('writes the file tags it was given, and only those', () => {
    const edit: MetadataEdit = { tags: { title: 'Heat', date: '1995', nonsense: 'x' } }
    const plan = analyzeFile(film(), settings, edit).plan
    expect(plan.metadataTags).toEqual({ title: 'Heat', date: '1995' })
    expect(plan.strategy).toBe('remux')

    const { args } = buildRepairCommand({ result: analyzeFile(film(), settings, edit), settings, outputPath: '/out.mp4' })
    // After the wholesale copy of what was there, so it wins.
    const copied = args.indexOf('-map_metadata')
    expect(args.indexOf('title=Heat')).toBeGreaterThan(copied)
    expect(args).toContain('date=1995')
    expect(args.join(' ')).not.toContain('nonsense')
  })

  it('moves the default flag to the track a person chose', () => {
    const edit: MetadataEdit = { tracks: { 1: { default: false }, 2: { default: true } } }
    const plan = analyzeFile(film(), settings, edit).plan
    const changes = new Map(plan.trackChanges.map((change) => [change.streamIndex, change]))
    expect(changes.get(1)?.setDefault).toBe(false)
    expect(changes.get(2)?.setDefault).toBe(true)
  })

  it('beats the rule that had a view about the same track', () => {
    // Left alone, the commentary track is passed over for the default flag.
    const automatic = analyzeFile(film(), settings).plan.trackChanges.find((c) => c.streamIndex === 2)
    expect(automatic?.setDefault).not.toBe(true)

    const chosen = analyzeFile(film(), settings, { tracks: { 2: { default: true } } }).plan.trackChanges.find(
      (c) => c.streamIndex === 2
    )
    expect(chosen?.setDefault).toBe(true)
  })

  it('does not undo the rest of what that rule decided', () => {
    // The untagged track gets a language from the rules; the person only
    // renames it, and should not lose the language by doing so.
    const file = mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'und' })])
    const automatic = analyzeFile(file, settings).plan.trackChanges.find((c) => c.streamIndex === 1)
    expect(automatic?.setLanguage).toBe('eng')

    const edited = analyzeFile(file, settings, { tracks: { 1: { title: 'Main' } } }).plan.trackChanges.find(
      (c) => c.streamIndex === 1
    )
    expect(edited?.setLanguage).toBe('eng')
    expect(edited?.setTitle).toBe('Main')
  })

  it('writes a track name into the command', () => {
    const result = analyzeFile(film(), settings, { tracks: { 2: { title: 'Commentary' } } })
    const { args } = buildRepairCommand({ result, settings, outputPath: '/out.mp4' })
    expect(args).toContain('title=Commentary')
  })

  it('lets a name be cleared, which is not the same as not setting one', () => {
    const result = analyzeFile(film(), settings, { tracks: { 2: { title: '' } } })
    const { args } = buildRepairCommand({ result, settings, outputPath: '/out.mp4' })
    expect(args).toContain('title=')
  })

  it('leaves a track that is being dropped alone', () => {
    // A picture subtitle has nowhere to go in an MP4 and is being left out;
    // renaming something that will not be there is not an instruction worth
    // acting on, and a change that contradicts a drop is worse. (A styled text
    // track would not do here: those are converted, not dropped.)
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', language: 'eng', isImageBased: true })
    ])
    const plan = analyzeFile(file, settings, { tracks: { 2: { title: 'Signs' } } }).plan
    const forTrack = plan.trackChanges.filter((change) => change.streamIndex === 2)
    expect(forTrack).toHaveLength(1)
    expect(forTrack[0].drop).toBe(true)
    expect(forTrack[0].setTitle).toBeUndefined()
  })
})

describe('what an edit costs', () => {
  it('can still be written in place when it is only flags and languages', () => {
    const file = mp4([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng', disposition: flags({ default: true }) }),
      audio({ index: 2, language: 'eng' })
    ])
    const result = analyzeFile(file, settings, { tracks: { 1: { default: false }, 2: { default: true } } })
    expect(inPlaceVerdict(result).changes?.length).toBeGreaterThan(0)
  })

  it('has to rewrite the file for a track name', () => {
    const result = analyzeFile(film(), settings, { tracks: { 2: { title: 'Commentary' } } })
    expect(inPlaceVerdict(result).refusal).toBe('changes-a-track-name')
  })

  it('has to rewrite the file for a file tag', () => {
    const result = analyzeFile(film(), settings, { tags: { title: 'Heat' } })
    expect(inPlaceVerdict(result).refusal).toBe('changes-the-file-tags')
  })
})

/**
 * Season and episode numbers, which arrive in two forms and must leave in one.
 *
 * A lookup gives `5`; a file somebody else wrote says `05`; somebody typing
 * into the box may give either. Three forms of the same season name the file
 * three different ways and make an edit that changes nothing look like a
 * repair, so there is one way to write the number and the rest are normalised
 * to it on the way in and on the way out.
 */
describe('season and episode numbers', () => {
  it('takes the leading zeros off, and nothing else', () => {
    expect(bareNumber('01')).toBe('1')
    expect(bareNumber('007')).toBe('7')
    expect(bareNumber(' 012 ')).toBe('12')
    expect(bareNumber('14')).toBe('14')
  })

  it('keeps season 0, which is where specials live', () => {
    expect(bareNumber('0')).toBe('0')
    expect(bareNumber('00')).toBe('0')
  })

  it('leaves something that is not a number alone rather than mangling it', () => {
    expect(bareNumber('Pilot')).toBe('Pilot')
    expect(bareNumber('')).toBe('')
  })

  it('normalises what the file says', () => {
    const file = mp4([video()], { tags: { show: 'The Wire', season_number: '01', episode_id: '03' } })
    expect(tagsOf(file)).toEqual({ show: 'The Wire', season_number: '1', episode_id: '3' })
  })

  it('normalises what is about to be written', () => {
    expect(cleanTags({ season_number: '01', episode_id: '003' })).toEqual({
      season_number: '1',
      episode_id: '3'
    })
  })

  it('does not call a padded number a change worth rewriting the file for', () => {
    const file = mp4([video()], { tags: { season_number: '01', episode_id: '03' } })
    expect(changesAnything({ tags: { season_number: '1', episode_id: '3' } }, file)).toBe(false)
    // Typed back exactly as the file has it, which is the same number again.
    expect(changesAnything({ tags: { season_number: '01', episode_id: '03' } }, file)).toBe(false)
    // A real change is still a change.
    expect(changesAnything({ tags: { season_number: '2' } }, file)).toBe(true)
  })
})

describe('what the editor starts with', () => {
  const guessed = { show: 'The Expanse', season: 2, episode: 6, year: '2017' }

  it('prefers what the file states over what its name suggests', () => {
    // The bug: the fields were seeded from the name alone, and a lookup writes
    // back whatever is in them — so picking a series could overwrite a correct
    // `episode_id` with a number read out of the file name. A tag is evidence;
    // a name is an inference, and an inference must not replace a statement.
    const fields = episodeFieldsFor(
      { show: 'The Expanse', season_number: '2', episode_id: '6' },
      { ...guessed, season: 20, episode: 206 },
      'The Expanse',
      undefined
    )

    expect(fields.season).toBe('2')
    expect(fields.episode).toBe('6')
  })

  it('falls back to the name when the file says nothing', () => {
    const fields = episodeFieldsFor({}, guessed, 'Whatever', undefined)
    expect(fields).toMatchObject({ isEpisode: true, show: 'The Expanse', season: '2', episode: '6', year: '2017' })
  })

  it('treats a file with episode tags as an episode even when the name is silent', () => {
    // A file named `ep6.mkv` tells a pattern nothing, but a file carrying a
    // season and an episode has said what it is.
    const fields = episodeFieldsFor({ season_number: '1', episode_id: '3' }, undefined, 'ep6', undefined)
    expect(fields.isEpisode).toBe(true)
    expect(fields.season).toBe('1')
  })

  it('is a film when neither the tags nor the name say otherwise', () => {
    const fields = episodeFieldsFor({}, undefined, 'Arrival', '2016')
    expect(fields).toMatchObject({ isEpisode: false, show: 'Arrival', season: '', episode: '', year: '2016' })
  })

  it('takes the year from the date the file carries', () => {
    const fields = episodeFieldsFor({ date: '2017-02-01' }, guessed, 'The Expanse', undefined)
    expect(fields.year).toBe('2017')
  })
})
