/**
 * Looking a selection up at once.
 *
 * Two things are worth testing here. Which rows arrive ticked, because
 * everything here goes on to rewrite files and a screen that ticks everything
 * is a screen people click through. And what the question is — an episode
 * looked up by its title rather than its number is looked up wrongly, however
 * good the answer looks.
 */

import { describe, expect, it } from 'vitest'
import {
  askFor,
  episodeProposal,
  isAskable,
  judge,
  movieProposal,
  takenCount,
  unaskable,
  whatIsMissing,
  type AskedFor
} from '@shared/plex/bulk-metadata.js'
import type { TmdbEpisode, TmdbMatch } from '@shared/tmdb.js'
import { mainAudio, mkv, video } from './fixtures.js'

const match = (title: string, year?: string, id = 1): TmdbMatch => ({
  id,
  kind: 'movie',
  title,
  year,
  overview: 'A summary.'
})

const series = (title: string, year?: string, id = 1): TmdbMatch => ({ ...match(title, year, id), kind: 'tv' })

const anEpisode = (title: string): TmdbEpisode => ({
  series: series('Breaking Bad', '2008'),
  season: 5,
  number: 14,
  title,
  date: '2013-09-15',
  overview: 'Everything comes apart.'
})

const file = (fileName: string) => mkv([video(), mainAudio()], { fileName, path: `/m/${fileName}` })

const movie = (query: string, year = ''): Extract<AskedFor, { kind: 'movie' }> => ({ kind: 'movie', query, year })
const tv = (show: string, season: string, episode: string, year = ''): Extract<AskedFor, { kind: 'tv' }> => ({
  kind: 'tv',
  show,
  season,
  episode,
  year
})

describe('askFor', () => {
  it('asks for a film by title and year', () => {
    expect(askFor(file('Casino.Royale.2006.1080p.BluRay.x264.mkv'), 'movie')).toEqual({
      kind: 'movie',
      query: 'Casino Royale',
      year: '2006'
    })
  })

  it('asks for an episode by series, season and number', () => {
    // Not by its title: two series share episode names, and half the
    // episodes in a library have no name in the file at all.
    expect(askFor(file('Breaking.Bad.S05E14.1080p.mkv'), 'tv')).toEqual({
      kind: 'tv',
      show: 'Breaking Bad',
      season: '5',
      episode: '14',
      year: ''
    })
  })

  it('keeps a year that tells two series of a name apart', () => {
    expect(askFor(file('Doctor Who (2005) - S01E01 - Rose.mkv'), 'tv')).toMatchObject({
      show: 'Doctor Who',
      year: '2005'
    })
  })

  it('still guesses the series when the numbers are not in the name', () => {
    expect(askFor(file('Breaking Bad - Ozymandias.mkv'), 'tv')).toMatchObject({
      show: 'Breaking Bad - Ozymandias',
      season: '',
      episode: ''
    })
  })
})

describe('isAskable', () => {
  it('needs a title for a film, and all three for an episode', () => {
    expect(isAskable(movie('Heat'))).toBe(true)
    expect(isAskable(movie('  '))).toBe(false)
    expect(isAskable(tv('Breaking Bad', '5', '14'))).toBe(true)
    expect(isAskable(tv('Breaking Bad', '', '14'))).toBe(false)
    expect(isAskable(tv('', '5', '14'))).toBe(false)
    expect(isAskable(tv('Breaking Bad', 'five', '14'))).toBe(false)
  })

  it('takes season zero, which is how a special is numbered', () => {
    expect(isAskable(tv('Breaking Bad', '0', '1'))).toBe(true)
  })

  it('says what is missing', () => {
    expect(whatIsMissing(tv('', '5', '14'))).toContain('series name')
    expect(whatIsMissing(tv('Breaking Bad', '', ''))).toContain('season and episode')
    expect(whatIsMissing(movie(''))).toContain('title')
  })
})

describe('judge', () => {
  it('trusts a year that agrees', () => {
    expect(judge('2006', 'Casino Royale', [match('Casino Royale', '2006')])).toEqual({ level: 'good' })
  })

  it('does not trust a year that disagrees', () => {
    const verdict = judge('2006', 'Casino Royale', [match('Casino Royale', '1967')])
    expect(verdict.level === 'check' && verdict.why).toContain('1967')
  })

  it('does not trust a result shorter than what was asked for', () => {
    expect(judge('2006', 'Casino Royale', [match('Casino', '2006')]).level).toBe('check')
  })

  it('takes a single answer on trust even with no year to check it against', () => {
    expect(judge('', 'Heat', [match('Heat', '1995')])).toEqual({ level: 'good' })
  })

  it('does not trust a tie with no year to break it', () => {
    expect(judge('', 'Heat', [match('Heat', '1995', 1), match('Heat', '1995', 2)]).level).toBe('check')
  })

  it('says so when there is nothing at all', () => {
    expect(judge('2006', 'Casino Royale', [])).toEqual({ level: 'check', why: 'nothing found' })
  })
})

describe('movieProposal', () => {
  it('ticks a confident row and nothing else', () => {
    const asked = movie('Casino Royale', '2006')
    const good = movieProposal(file('a.mkv'), asked, [match('Casino Royale', '2006')])
    expect(good.take).toBe(true)
    expect(good.found?.tags.title).toBe('Casino Royale')

    const doubtful = movieProposal(file('a.mkv'), asked, [match('Casino Royale', '1967')])
    expect(doubtful.take).toBe(false)
    expect(doubtful.found).toBeDefined()
  })

  it('keeps the other answers to pick from instead', () => {
    const rows = movieProposal(file('Heat.mkv'), movie('Heat'), [match('Heat', '1995', 1), match('Heat', '1986', 2)])
    expect(rows.alternatives.map((option) => option.id)).toEqual([1, 2])
  })

  it('says plainly when nothing matched', () => {
    const none = movieProposal(file('Zzz.mkv'), movie('Zzz'), [])
    expect(none.take).toBe(false)
    expect(none.problem).toContain('Nothing on themoviedb.org')
  })
})

describe('episodeProposal', () => {
  const asked = tv('Breaking Bad', '5', '14')

  it('writes the episode’s own name, with the series beside it', () => {
    const row = episodeProposal(file('bb.mkv'), asked, [series('Breaking Bad', '2008')], anEpisode('Ozymandias'))
    expect(row.take).toBe(true)
    expect(row.found?.tags).toMatchObject({
      title: 'Ozymandias',
      show: 'Breaking Bad',
      season_number: '5',
      episode_id: '14'
    })
    // The numbers the file will be named with, not a padded form of them.
    expect(row.found?.label).toContain('S5E14')
  })

  it('tells a missing series from a missing episode', () => {
    const noSeries = episodeProposal(file('bb.mkv'), asked, [], undefined)
    expect(noSeries.problem).toContain('No series')

    // The series is right and the numbering is not, which is a thing a
    // person can fix and more searching cannot.
    const noEpisode = episodeProposal(file('bb.mkv'), asked, [series('Breaking Bad', '2008')], undefined)
    expect(noEpisode.problem).toContain('no season 5 episode 14')
    expect(noEpisode.take).toBe(false)
  })

  it('does not trust a series name that matched more than one series', () => {
    const row = episodeProposal(
      file('dw.mkv'),
      tv('Doctor Who', '1', '1'),
      [series('Doctor Who', '2005', 1), series('Doctor Who', '1963', 2)],
      anEpisode('Rose')
    )
    expect(row.take).toBe(false)
    expect(row.confidence.level === 'check' && row.confidence.why).toContain('more than one series')
  })

  it('trusts it once a year has been given to tell them apart', () => {
    const row = episodeProposal(
      file('dw.mkv'),
      tv('Doctor Who', '1', '1', '2005'),
      [series('Doctor Who', '2005', 1), series('Doctor Who', '1963', 2)],
      anEpisode('Rose')
    )
    expect(row.take).toBe(true)
  })
})

describe('counting what will be written', () => {
  it('counts only the ticked rows that found something', () => {
    const rows = [
      movieProposal(file('a.mkv'), movie('Casino Royale', '2006'), [match('Casino Royale', '2006')]),
      unaskable(file('b.mkv'), movie(''))
    ]
    expect(takenCount(rows)).toBe(1)
    expect(takenCount(rows.map((row) => ({ ...row, take: true })))).toBe(1)
  })
})
