/**
 * Looking a film up.
 *
 * The request itself is made in Rust and is not tested here; everything that
 * decides *what* is asked for and what the answer means is, because that is
 * where being wrong produces a file confidently labelled as the wrong film.
 */

import { describe, expect, it } from 'vitest'
import {
  detailsUrl,
  guessTitle,
  parseDetails,
  parseSearch,
  searchUrl,
  tagsFromMatch
} from '@shared/tmdb.js'

const KEY = 'abcdef0123456789abcdef0123456789'

describe('the address asked for', () => {
  it('searches for a film by name', () => {
    const url = new URL(searchUrl(KEY, 'movie', 'Casino Royale'))
    expect(url.origin + url.pathname).toBe('https://api.themoviedb.org/3/search/movie')
    expect(url.searchParams.get('query')).toBe('Casino Royale')
    expect(url.searchParams.get('api_key')).toBe(KEY)
    expect(url.searchParams.get('year')).toBeNull()
  })

  it('narrows by year when there is one', () => {
    expect(new URL(searchUrl(KEY, 'movie', 'Casino Royale', '2006')).searchParams.get('year')).toBe('2006')
    expect(new URL(searchUrl(KEY, 'tv', 'Sherlock', '2010')).searchParams.get('first_air_date_year')).toBe('2010')
  })

  it('leaves out a year that is not one, rather than finding nothing', () => {
    // A year the search cannot use narrows the results to none, which reads
    // as "there is no such film" instead of "that was not a year".
    expect(new URL(searchUrl(KEY, 'movie', 'Heat', 'nineteen ninety five')).searchParams.get('year')).toBeNull()
    expect(new URL(searchUrl(KEY, 'movie', 'Heat', '95')).searchParams.get('year')).toBeNull()
  })

  it('escapes what it is given', () => {
    const url = new URL(searchUrl(KEY, 'movie', 'Fast & Furious'))
    expect(url.searchParams.get('query')).toBe('Fast & Furious')
    expect(url.toString()).toContain('Fast+%26+Furious')
  })

  it('asks for one title in full', () => {
    const url = new URL(detailsUrl(KEY, 'movie', 36557))
    expect(url.origin + url.pathname).toBe('https://api.themoviedb.org/3/movie/36557')
  })

  it('only ever addresses the one host', () => {
    for (const built of [searchUrl(KEY, 'movie', '../../evil'), detailsUrl(KEY, 'tv', 1)]) {
      expect(built.startsWith('https://api.themoviedb.org/3/')).toBe(true)
    }
  })
})

describe('reading what comes back', () => {
  const body = JSON.stringify({
    results: [
      { id: 36557, title: 'Casino Royale', release_date: '2006-11-14', overview: 'Bond earns his licence.' },
      { id: 1, title: 'Casino Royale', release_date: '1967-04-13', overview: 'The other one.' },
      { id: 2, overview: 'No name, so no use to anybody.' },
      { title: 'No id either' },
      'not even an object'
    ]
  })

  it('keeps the order the database sent', () => {
    const matches = parseSearch(body, 'movie')
    expect(matches.map((match) => match.year)).toEqual(['2006', '1967'])
  })

  it('drops anything that could not be picked', () => {
    expect(parseSearch(body, 'movie')).toHaveLength(2)
  })

  it('reads a series by the name a series has', () => {
    const tv = JSON.stringify({ results: [{ id: 19885, name: 'Sherlock', first_air_date: '2010-07-25' }] })
    expect(parseSearch(tv, 'tv')[0]).toMatchObject({ title: 'Sherlock', year: '2010' })
  })

  it('does not fall over on an answer it did not expect', () => {
    expect(parseSearch('{}', 'movie')).toEqual([])
    expect(parseSearch('{"results":"nope"}', 'movie')).toEqual([])
    expect(parseSearch('null', 'movie')).toEqual([])
  })

  it('takes the genres from a title in full', () => {
    const details = JSON.stringify({
      id: 36557,
      title: 'Casino Royale',
      release_date: '2006-11-14',
      overview: 'Bond earns his licence.',
      genres: [{ id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }, { id: 99 }]
    })
    expect(parseDetails(details, 'movie')?.genres).toEqual(['Action', 'Adventure'])
  })

  it('says nothing rather than something wrong when the answer is unusable', () => {
    expect(parseDetails('{"overview":"orphan"}', 'movie')).toBeUndefined()
  })
})

describe('what a match would write', () => {
  it('writes the title, the date, the summary and the genres', () => {
    expect(
      tagsFromMatch({
        id: 1,
        kind: 'movie',
        title: 'Casino Royale',
        date: '2006-11-14',
        year: '2006',
        overview: 'Bond earns his licence.',
        genres: ['Action', 'Adventure']
      })
    ).toEqual({
      title: 'Casino Royale',
      date: '2006-11-14',
      description: 'Bond earns his licence.',
      genre: 'Action, Adventure'
    })
  })

  it('falls back to the year when that is all there is', () => {
    expect(tagsFromMatch({ id: 1, kind: 'movie', title: 'X', year: '1999', overview: '' })).toEqual({
      title: 'X',
      date: '1999'
    })
  })

  it('leaves out what the database did not say', () => {
    expect(tagsFromMatch({ id: 1, kind: 'movie', title: 'X', overview: '' })).toEqual({ title: 'X' })
  })
})

describe('guessing what to search for', () => {
  it('takes the title and the year off a release name', () => {
    expect(guessTitle('Casino.Royale.2006.1080p.BluRay.x264.mkv')).toEqual({
      title: 'Casino Royale',
      year: '2006'
    })
  })

  it('handles the bracketed form Plex asks for', () => {
    expect(guessTitle('Casino Royale (2006).m4v')).toEqual({ title: 'Casino Royale', year: '2006' })
  })

  it('stops at the encoding noise even without a year', () => {
    expect(guessTitle('Heat.1080p.WEB-DL.DDP5.1.mkv')).toEqual({ title: 'Heat', year: undefined })
  })

  it('leaves a plain name alone', () => {
    expect(guessTitle('Heat.mkv')).toEqual({ title: 'Heat', year: undefined })
    expect(guessTitle('The Good, the Bad and the Ugly.mkv').title).toBe('The Good, the Bad and the Ugly')
  })

  it('does not mistake a number in a title for the year', () => {
    // Two numbers that look like years, and only one of them is one.
    expect(guessTitle('Blade Runner 2049 (2017).mkv')).toEqual({ title: 'Blade Runner 2049', year: '2017' })
    expect(guessTitle('2012 (2009).mkv')).toEqual({ title: '2012', year: '2009' })
    expect(guessTitle('1917 (2019).mkv')).toEqual({ title: '1917', year: '2019' })
  })

  it('takes the last year when there are no brackets to go by', () => {
    expect(guessTitle('Blade.Runner.2049.2017.1080p.BluRay.mkv')).toEqual({
      title: 'Blade Runner 2049',
      year: '2017'
    })
  })

  it('cannot tell a title that is a year from a release year, and says so by guessing', () => {
    // `1917.mkv` is either the film or a mislabelled release. Nothing short of
    // asking can tell, and the search box is editable for exactly this.
    expect(guessTitle('1917.mkv')).toEqual({ title: '', year: '1917' })
  })
})
