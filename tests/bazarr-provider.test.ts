/**
 * Bazarr, against saved replies.
 *
 * Every body here was written from Bazarr's own source — the Flask-RestX
 * models in `bazarr/api/providers/providers_movies.py` and
 * `providers_episodes.py`, the result dict built in `subtitles/manual.py`, and
 * the `subtitles_model` in `api/swaggerui.py`. The point of a provider that
 * only describes requests and reads replies is that this is the whole of what
 * needs proving: nothing here reaches a network, and a wire format is not
 * something to find out from production.
 */

import { describe, expect, it } from 'vitest'
import { bazarr, BAZARR_ID, tail } from '@shared/subtitles/providers/bazarr.js'
import { providerById, PROVIDERS } from '@shared/subtitles/providers/index.js'
import {
  isProblem,
  isStep,
  type HttpReply,
  type ProviderProblem,
  type SubtitleCandidate,
  type SubtitleQuery,
  type SubtitleStep
} from '@shared/subtitles/providers/types.js'

const CREDENTIAL = { url: 'http://nas:6767', apiKey: 'a-bazarr-key' }

const FILM = '/Volumes/media/Films/Solaris (1972)/Solaris (1972).mkv'
const EPISODE = '/Volumes/media/TV/Dark/Season 01/Dark - S01E03.mkv'

function reply(body: unknown, status = 200): HttpReply {
  return { status, text: typeof body === 'string' ? body : JSON.stringify(body) }
}

function query(extra: Partial<SubtitleQuery> = {}): SubtitleQuery {
  return { languages: ['eng'], filePath: FILM, ...extra }
}

function stepOf(answer: SubtitleCandidate[] | SubtitleStep | ProviderProblem): SubtitleStep {
  if (isProblem(answer)) throw new Error(answer.problem)
  if (!isStep(answer)) throw new Error('wanted another request, got candidates')
  return answer
}

function candidatesOf(answer: SubtitleCandidate[] | SubtitleStep | ProviderProblem): SubtitleCandidate[] {
  if (isProblem(answer)) throw new Error(answer.problem)
  if (isStep(answer)) throw new Error(`wanted candidates, got a follow-up to ${answer.follow.url}`)
  return answer
}

/* Bazarr reports the path it was given by Radarr, which is a container's. */
const MOVIES = {
  data: [
    { radarrId: 4, title: 'Stalker', path: '/movies/Stalker (1979)/Stalker (1979).mkv' },
    { radarrId: 11, title: 'Solaris', path: '/movies/Solaris (1972)/Solaris (1972).mkv' }
  ],
  total: 2
}

const SERIES = {
  data: [
    { sonarrSeriesId: 2, title: 'Dark Matter', path: '/tv/Dark Matter' },
    { sonarrSeriesId: 7, title: 'Dark', path: '/tv/Dark' }
  ],
  total: 2
}

const EPISODES = {
  data: [
    { sonarrSeriesId: 7, sonarrEpisodeId: 300, season: 1, episode: 2, path: '/tv/Dark/Season 01/Dark - S01E02.mkv' },
    { sonarrSeriesId: 7, sonarrEpisodeId: 301, season: 1, episode: 3, path: '/tv/Dark/Season 01/Dark - S01E03.mkv' }
  ],
  total: 2
}

/** One hash match and one name match, as `manual_search` builds them. */
const SUBTITLES = {
  data: [
    {
      score: 98.5,
      orig_score: 234,
      score_without_hash: 120,
      forced: 'False',
      language: 'eng',
      hearing_impaired: 'False',
      provider: 'opensubtitles',
      subtitle: 'cache-key-aaa',
      url: 'https://www.opensubtitles.com/en/subtitles/1',
      original_format: false,
      matches: ['hash', 'hearing_impaired'],
      dont_matches: [],
      release_info: ['Solaris.1972.BluRay.1080p', 'Solaris.1972.REMUX'],
      uploader: 'someone'
    },
    {
      score: 61.25,
      orig_score: 80,
      score_without_hash: 80,
      forced: 'False',
      language: 'eng',
      hearing_impaired: 'True',
      provider: 'podnapisi',
      subtitle: 'cache-key-bbb',
      url: null,
      original_format: true,
      matches: ['title', 'year'],
      dont_matches: ['hash'],
      release_info: [],
      uploader: null
    }
  ]
}

describe('the registry', () => {
  it('has Bazarr in it under its own id', () => {
    expect(providerById(BAZARR_ID)).toBe(bazarr)
    expect(PROVIDERS.map((provider) => provider.id)).toContain('bazarr')
  })

  it('says plainly that it does not hand a subtitle back', () => {
    expect(bazarr.delivers).toBe('to-the-folder')
    // And therefore has to be able to say where it put it.
    expect(typeof bazarr.collect).toBe('function')
    expect(typeof bazarr.readCollect).toBe('function')
  })
})

describe('refusing rather than guessing', () => {
  it('will not build a request without an address', () => {
    const built = bazarr.search(query(), { apiKey: 'k' })
    expect(isProblem(built) && built.problem).toContain('No Bazarr address')
  })

  it('will not build a request without a key', () => {
    const built = bazarr.search(query(), { url: 'http://nas:6767' })
    expect(isProblem(built) && built.problem).toContain('No Bazarr API key')
  })

  it('says why it cannot answer about a file with no path', () => {
    const built = bazarr.search({ languages: ['eng'] }, CREDENTIAL)
    expect(isProblem(built) && built.problem).toContain('where it is')
  })

  it('tidies an address pasted out of Bazarr’s own hash-routed URL bar', () => {
    const built = bazarr.search(query(), { ...CREDENTIAL, url: 'http://nas:6767/#/settings' })
    if (isProblem(built)) throw new Error(built.problem)
    // Everything after a `#` is never sent, so leaving it in would have
    // requested the root of the host and read whatever came back.
    expect(built.url).toBe('http://nas:6767/api/movies?start=0&length=-1')
  })
})

describe('finding the film', () => {
  it('asks for the library first, because there is no "which film is this" call', () => {
    const built = bazarr.search(query(), CREDENTIAL)
    if (isProblem(built)) throw new Error(built.problem)
    expect(built.url).toBe('http://nas:6767/api/movies?start=0&length=-1')
    expect(built.headers?.['X-API-KEY']).toBe('a-bazarr-key')
  })

  it('matches the film across a different mount and asks for its subtitles', () => {
    const next = stepOf(bazarr.readSearch(reply(MOVIES), query(), undefined, CREDENTIAL))
    // Bazarr says `/movies/...`; this machine says `/Volumes/media/Films/...`.
    expect(next.follow.url).toBe('http://nas:6767/api/providers/movies?radarrid=11')
    expect(next.step).toBe('movie:11')
  })

  it('says so rather than matching the wrong film when the path is not there', () => {
    const answer = bazarr.readSearch(reply(MOVIES), query({ filePath: '/elsewhere/Andrei Rublev.mkv' }), undefined, CREDENTIAL)
    expect(isProblem(answer) && answer.problem).toContain('no film at that path')
  })
})

describe('finding the episode', () => {
  const tv = query({ filePath: EPISODE, season: 1, episode: 3 })

  it('asks for series rather than films when both numbers are there', () => {
    const built = bazarr.search(tv, CREDENTIAL)
    if (isProblem(built)) throw new Error(built.problem)
    expect(built.url).toBe('http://nas:6767/api/series?start=0&length=-1')
  })

  it('picks the series whose folder the file is in, not one it starts with', () => {
    const next = stepOf(bazarr.readSearch(reply(SERIES), tv, undefined, CREDENTIAL))
    expect(next.follow.url).toBe('http://nas:6767/api/episodes?seriesid[]=7')
    expect(next.step).toBe('episodes:7')
  })

  it('does not put an episode of Dark Matter into Dark', () => {
    /*
     * The case a `startsWith` or an `includes` gets wrong, and the reason the
     * comparison is by whole path segment. `Dark` is listed second but is a
     * prefix of `Dark Matter`, so a substring test matches the shorter name
     * against the longer folder and files every episode under the wrong show
     * — which would then be sent to Bazarr as an episode id that is not this
     * file at all.
     */
    const elsewhere = query({
      filePath: '/Volumes/media/TV/Dark Matter/Season 01/Dark Matter - S01E03.mkv',
      season: 1,
      episode: 3
    })
    const reversed = reply({ data: [...SERIES.data].reverse(), total: 2 })
    expect(stepOf(bazarr.readSearch(reversed, elsewhere, undefined, CREDENTIAL)).step).toBe('episodes:2')
  })

  it('picks the episode by its path rather than by the numbers in its name', () => {
    const next = stepOf(bazarr.readSearch(reply(EPISODES), tv, 'episodes:7', CREDENTIAL))
    expect(next.follow.url).toBe('http://nas:6767/api/providers/episodes?episodeid=301')
    expect(next.step).toBe('episode:7:301')
  })

  it('still finds it when the numbers disagree with the path', () => {
    // A release numbered differently from the series itself: the file is
    // S01E03 on disk and something read it as episode 9. The path wins.
    const wrong = query({ filePath: EPISODE, season: 1, episode: 9 })
    const next = stepOf(bazarr.readSearch(reply(EPISODES), wrong, 'episodes:7', CREDENTIAL))
    expect(next.follow.url).toContain('episodeid=301')
  })
})

describe('reading the subtitles on offer', () => {
  it('reads what matters off each one', () => {
    const found = candidatesOf(bazarr.readSearch(reply(SUBTITLES), query(), 'movie:11', CREDENTIAL))
    expect(found).toHaveLength(2)
    expect(found[0]).toMatchObject({
      provider: 'bazarr',
      language: 'eng',
      release: 'Solaris.1972.BluRay.1080p',
      // `hash` among the things this subtitle agreed with the file about.
      hashMatch: true,
      hearingImpaired: false,
      forced: false,
      uploader: 'someone'
    })
    // Bazarr scores out of a hundred; everything else here is out of ten.
    expect(found[0].rating).toBe(9.9)
    expect(found[1].hashMatch).toBe(false)
    expect(found[1].hearingImpaired).toBe(true)
    expect(found[1].uploader).toBeUndefined()
  })

  it('carries the ids the chain discovered, because the download needs them', () => {
    const film = candidatesOf(bazarr.readSearch(reply(SUBTITLES), query(), 'movie:11', CREDENTIAL))
    expect(JSON.parse(film[0].id)).toEqual({
      kind: 'movie',
      id: 11,
      from: 'opensubtitles',
      subtitle: 'cache-key-aaa',
      hi: false,
      forced: false,
      originalFormat: false
    })

    const episode = candidatesOf(bazarr.readSearch(reply(SUBTITLES), query(), 'episode:7:301', CREDENTIAL))
    expect(JSON.parse(episode[0].id)).toMatchObject({ kind: 'episode', id: 7, episodeId: 301 })
  })

  it('survives a reply that is nothing like the documented one', () => {
    for (const body of [{}, { data: 'not an array' }, { data: [null, 7, 'x'] }, []]) {
      const answer = bazarr.readSearch(reply(body), query(), 'movie:11', CREDENTIAL)
      expect(isProblem(answer) ? [] : answer).toEqual([])
    }
  })

  it('says what went wrong rather than throwing', () => {
    const rejected = bazarr.readSearch(reply('', 401), query(), 'movie:11', CREDENTIAL)
    expect(isProblem(rejected) && rejected.needsLogin).toBe(true)
    expect(isProblem(bazarr.readSearch(reply('<html>nope</html>'), query(), 'movie:11', CREDENTIAL))).toBe(true)
  })
})

describe('asking for one', () => {
  const candidate = (): SubtitleCandidate =>
    candidatesOf(bazarr.readSearch(reply(SUBTITLES), query(), 'movie:11', CREDENTIAL))[0]

  it('posts the form Flask’s reqparse is expecting', () => {
    const built = bazarr.download(candidate(), CREDENTIAL)
    if (isProblem(built)) throw new Error(built.problem)

    expect(built.url).toBe('http://nas:6767/api/providers/movies')
    expect(built.method).toBe('POST')
    expect(built.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded')

    const form = new URLSearchParams(built.body)
    expect(form.get('radarrid')).toBe('11')
    expect(form.get('provider')).toBe('opensubtitles')
    expect(form.get('subtitle')).toBe('cache-key-aaa')
    // The handler calls `.capitalize()` on these and compares them against
    // Python's own spelling of a bool, so `true` would never match.
    expect(form.get('hi')).toBe('False')
    expect(form.get('forced')).toBe('False')
    expect(form.get('original_format')).toBe('False')
  })

  it('posts both ids for an episode', () => {
    const episode = candidatesOf(bazarr.readSearch(reply(SUBTITLES), query(), 'episode:7:301', CREDENTIAL))[0]
    const built = bazarr.download(episode, CREDENTIAL)
    if (isProblem(built)) throw new Error(built.problem)

    expect(built.url).toBe('http://nas:6767/api/providers/episodes')
    const form = new URLSearchParams(built.body)
    expect(form.get('seriesid')).toBe('7')
    expect(form.get('episodeid')).toBe('301')
  })

  it('refuses a candidate that came from somewhere else', () => {
    const foreign: SubtitleCandidate = { provider: 'bazarr', id: '990001', language: 'eng', hashMatch: false }
    expect(isProblem(bazarr.download(foreign, CREDENTIAL))).toBe(true)
  })

  it('reads the empty 204 as "queued", not as "here is your subtitle"', () => {
    const answer = bazarr.readDownload({ status: 204, text: '' })
    expect(answer).toEqual({ inTheFolder: true })
  })

  it('quotes the message Bazarr sent with a failure', () => {
    const answer = bazarr.readDownload({ status: 500, text: '"Unable to save subtitles file"' })
    expect(isProblem(answer) && answer.problem).toContain('Unable to save subtitles file')
  })
})

describe('finding out where it went', () => {
  const candidate = (): SubtitleCandidate =>
    candidatesOf(bazarr.readSearch(reply(SUBTITLES), query(), 'movie:11', CREDENTIAL))[0]

  it('asks about the one film rather than the library again', () => {
    const built = bazarr.collect?.(candidate(), CREDENTIAL)
    if (!built || isProblem(built)) throw new Error('no request')
    expect(built.url).toBe('http://nas:6767/api/movies?radarrid[]=11')
  })

  const saved = (subtitles: unknown[]): HttpReply => reply({ data: [{ radarrId: 11, subtitles }], total: 1 })

  it('reports every file in the language asked for, with its size', () => {
    const answer = bazarr.readCollect?.(
      saved([
        { name: 'English', code2: 'en', code3: 'eng', path: '/movies/Solaris (1972)/Solaris.en.srt', file_size: 48_120 },
        { name: 'French', code2: 'fr', code3: 'fra', path: '/movies/Solaris (1972)/Solaris.fr.srt', file_size: 50_000 }
      ]),
      candidate()
    )
    expect(answer).toEqual({ saved: [{ path: '/movies/Solaris (1972)/Solaris.en.srt', sizeBytes: 48_120 }] })
  })

  it('ignores a track that is already inside the film', () => {
    // An embedded track has a language and no path; it is not something that
    // was fetched into the folder, and counting it would end the wait early.
    const answer = bazarr.readCollect?.(
      saved([{ name: 'English', code2: 'en', code3: 'eng', path: null, embedded_track_id: 3 }]),
      candidate()
    )
    expect(answer).toEqual({ saved: [] })
  })

  it('answers with an empty list, not a failure, before anything has arrived', () => {
    expect(bazarr.readCollect?.(reply({ data: [], total: 0 }), candidate())).toEqual({ saved: [] })
  })
})

describe('path arithmetic', () => {
  it('agrees about a file two systems spell differently', () => {
    expect(tail('/movies/Solaris (1972)/Solaris (1972).mkv')).toBe(tail(FILM))
  })

  it('does not confuse two films of the same name in different libraries', () => {
    expect(tail('/movies/Solaris (1972)/Solaris (1972).mkv')).not.toBe(tail('/movies/Solaris (2002)/Solaris (2002).mkv'))
  })

  it('reads a Windows path', () => {
    expect(tail('D:\\Films\\Solaris (1972)\\Solaris (1972).mkv')).toBe(tail(FILM))
  })
})
