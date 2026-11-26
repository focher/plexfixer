/**
 * Asking the metadata services, in the order of how much they know.
 *
 * The providers are tested against saved replies elsewhere. What is here is
 * the part that decides *who is asked and in what order*, and the three things
 * that go wrong if it decides badly:
 *
 * - asking the database first, so a guessed title wins over a service that
 *   knows which file this is;
 * - stopping at the first service, so a film Radarr never imported is reported
 *   as unknown although themoviedb.org has it;
 * - asking per file, so a library listing is fetched eighty times.
 *
 * The transport is a table of saved replies that counts what it was asked, so
 * all three are observable rather than inferred.
 */

import { describe, expect, it } from 'vitest'
import { askable, anythingAskable, metadataSession, type MetadataNet } from '@shared/metadata/service.js'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { isProblem, type HttpReply, type HttpRequest } from '@shared/metadata/providers/types.js'
import type { AppSettings } from '@shared/types.js'

const FILM = '/Volumes/media/Films/Solaris (1972)/Solaris (1972).mkv'
const EPISODE = '/Volumes/media/TV/Dark/Season 01/Dark - S01E03.mkv'

const EVERYTHING: AppSettings = {
  ...DEFAULT_SETTINGS,
  metadataProviders: ['tmdb', 'radarr', 'sonarr'],
  tmdbCredential: 'a-tmdb-key',
  radarrUrl: 'http://nas:7878',
  radarrApiKey: 'a-radarr-key',
  sonarrUrl: 'http://nas:8989',
  sonarrApiKey: 'a-sonarr-key'
}

/** Radarr's reply: the whole library, with the film's own file in it. */
const RADARR = [
  { id: 4, title: 'Stalker', year: 1979, movieFile: { path: '/movies/Stalker (1979)/Stalker (1979).mkv' } },
  {
    id: 11,
    title: 'Solaris',
    year: 1972,
    tmdbId: 593,
    movieFile: { path: '/movies/Solaris (1972)/Solaris (1972).mkv' }
  }
]

const SONARR_SERIES = [{ id: 7, title: 'Dark', year: 2017, tvdbId: 326_852, path: '/tv/Dark' }]

const SONARR_EPISODES = [
  {
    seasonNumber: 1,
    episodeNumber: 3,
    title: 'Past and Present',
    airDate: '2017-12-01',
    episodeFile: { path: '/tv/Dark/Season 01/Dark - S01E03.mkv' }
  }
]

const TMDB_SEARCH = {
  results: [{ id: 593, title: 'Solaris', release_date: '1972-03-20', overview: 'A psychologist is sent up.' }]
}

function transport(table: Record<string, unknown>): MetadataNet & { asked: string[]; posted: unknown[] } {
  const asked: string[] = []
  const posted: unknown[] = []
  return {
    asked,
    posted,
    fetch: async (request: HttpRequest): Promise<HttpReply> => {
      asked.push(request.url)
      if (request.body !== undefined) posted.push(JSON.parse(request.body) as unknown)
      const key = Object.keys(table).find((candidate) => request.url.includes(candidate))
      if (key === undefined) return { status: 404, text: 'no such saved reply' }
      return { status: 200, text: JSON.stringify(table[key]) }
    }
  }
}

describe('which services are worth asking', () => {
  it('leaves out one that is switched on but has nothing to reach it with', () => {
    // A Radarr whose address was cleared would otherwise be asked, and refuse,
    // once per file, for nothing.
    expect(askable({ ...EVERYTHING, radarrUrl: '' })).toEqual(['sonarr', 'tmdb'])
    expect(askable({ ...EVERYTHING, radarrApiKey: '' })).toEqual(['sonarr', 'tmdb'])
  })

  it('leaves out one that is set up but switched off', () => {
    expect(askable({ ...EVERYTHING, metadataProviders: ['tmdb'] })).toEqual(['tmdb'])
  })

  it('says when there is nothing at all', () => {
    const nothing = { ...DEFAULT_SETTINGS, metadataProviders: [], tmdbCredential: '' }
    expect(anythingAskable(nothing, 'movie')).toBe(false)
    expect(anythingAskable(EVERYTHING, 'movie')).toBe(true)
    // Radarr knows nothing about episodes, and Sonarr nothing about films.
    expect(anythingAskable({ ...EVERYTHING, metadataProviders: ['radarr'] }, 'tv')).toBe(false)
    expect(anythingAskable({ ...EVERYTHING, metadataProviders: ['sonarr'] }, 'movie')).toBe(false)
  })
})

describe('the order services are asked in', () => {
  it('asks the one that knows where the file is before the one that guesses', async () => {
    const net = transport({ '/api/v3/movie': RADARR, 'themoviedb.org': TMDB_SEARCH })
    const session = metadataSession(net, EVERYTHING)

    const answer = await session.lookUp({ kind: 'movie', filePath: FILM, title: 'Solaris', year: '1972' })
    if (isProblem(answer)) throw new Error(answer.problem)

    expect(answer.provider.id).toBe('radarr')
    expect(answer.matches[0].pathMatch).toBe(true)
    expect(answer.matches[0].tmdbId).toBe(593)
    // And themoviedb.org was never troubled with a guess at the title.
    expect(net.asked.some((url) => url.includes('themoviedb'))).toBe(false)
  })

  it('falls through to the database for a file the library manager never imported', async () => {
    const net = transport({ '/api/v3/movie': [], 'themoviedb.org': TMDB_SEARCH })
    const session = metadataSession(net, EVERYTHING)

    const answer = await session.lookUp({ kind: 'movie', filePath: '/elsewhere/Solaris.mkv', title: 'Solaris' })
    if (isProblem(answer)) throw new Error(answer.problem)

    // "Radarr has not heard of this" is an ordinary answer, not a failure.
    expect(answer.provider.id).toBe('tmdb')
    expect(answer.matches[0].title).toBe('Solaris')
    expect(answer.matches[0].pathMatch).toBe(false)
  })

  it('reports what every service said, not just the last one', async () => {
    const net = transport({ '/api/v3/movie': [], 'themoviedb.org': { results: [] } })
    const session = metadataSession(net, EVERYTHING)

    const answer = await session.lookUp({ kind: 'movie', filePath: '/elsewhere/Zzz.mkv', title: 'Zzz' })
    if (!isProblem(answer)) throw new Error('expected a problem')

    /*
     * "Radarr has no film at that path" alone reads as a failure of Radarr.
     * Followed by "The Movie Database found nothing" it is the whole story,
     * and the second half is the one that says the guessed title was wrong.
     */
    expect(answer.problem).toContain('Radarr')
    expect(answer.problem).toContain('Movie Database')
  })

  it('says plainly when nothing is set up rather than reporting a failure', async () => {
    const net = transport({})
    const bare = { ...DEFAULT_SETTINGS, metadataProviders: [], tmdbCredential: '' }
    const answer = await metadataSession(net, bare).lookUp({ kind: 'movie', title: 'Solaris' })

    expect(isProblem(answer) && answer.needsLogin).toBe(true)
    expect(net.asked).toEqual([])
  })

  it('does not ask Sonarr about a film or Radarr about an episode', async () => {
    const net = transport({ '/api/v3/series': SONARR_SERIES, 'themoviedb.org': { results: [] } })
    await metadataSession(net, EVERYTHING).lookUp({ kind: 'tv', filePath: EPISODE, title: 'Dark', season: 1, episode: 3 })
    expect(net.asked.some((url) => url.includes('/api/v3/movie'))).toBe(false)
  })
})

describe('asking once for eighty files', () => {
  it('fetches a library listing once and answers from it after that', async () => {
    const net = transport({ '/api/v3/movie': RADARR, 'themoviedb.org': TMDB_SEARCH })
    const session = metadataSession(net, EVERYTHING)

    /*
     * Radarr's only way to match a path is to return every film it has. Eighty
     * files asked one at a time would be eighty copies of a reply that is a
     * few megabytes for a large library.
     */
    for (let time = 0; time < 5; time += 1) {
      await session.lookUp({ kind: 'movie', filePath: FILM, title: 'Solaris' })
    }
    expect(net.asked.filter((url) => url.includes('/api/v3/movie'))).toHaveLength(1)
  })

  it('asks again once the session is told to forget', async () => {
    const net = transport({ '/api/v3/movie': RADARR })
    const session = metadataSession(net, EVERYTHING)

    await session.lookUp({ kind: 'movie', filePath: FILM })
    session.forget()
    await session.lookUp({ kind: 'movie', filePath: FILM })
    expect(net.asked).toHaveLength(2)
  })
})

describe('filling in what the search did not say', () => {
  it('finds the episode by the file Sonarr imported, not by the numbers in its name', async () => {
    const net = transport({ '/api/v3/series': SONARR_SERIES, '/api/v3/episode': SONARR_EPISODES })
    const session = metadataSession(net, EVERYTHING)

    const answer = await session.lookUp({ kind: 'tv', filePath: EPISODE, title: 'Dark', season: 1, episode: 9 })
    if (isProblem(answer)) throw new Error(answer.problem)

    // Asked about episode 9, because something read the name that way.
    const full = await session.fillIn({ ...answer.matches[0], season: 1, episode: 9, filePath: EPISODE })
    if (isProblem(full)) throw new Error(full.problem)

    // Answered with episode 3, because that is the file Sonarr put there.
    expect(full.episode).toBe(3)
    expect(full.episodeTitle).toBe('Past and Present')
    expect(full.pathMatch).toBe(true)
  })

  it('hands back a match unchanged from a service with nothing more to say', async () => {
    const net = transport({ '/api/v3/movie': RADARR })
    const session = metadataSession(net, EVERYTHING)

    const answer = await session.lookUp({ kind: 'movie', filePath: FILM })
    if (isProblem(answer)) throw new Error(answer.problem)

    // Radarr said everything it knows in the listing. "Nothing more" is an
    // answer and not a gap, so this must not read as a failure.
    const full = await session.fillIn(answer.matches[0])
    expect(isProblem(full)).toBe(false)
    expect(net.asked).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * Telling the library manager the file has been replaced
 * ------------------------------------------------------------------ */

describe('telling the library a file has been replaced', () => {
  /** What Radarr answers a command with. */
  const ACCEPTED = { id: 901, name: 'RescanMovie', status: 'queued' }

  it('names the film by the path the service still knows, and asks for a rescan', async () => {
    const net = transport({ '/api/v3/movie': RADARR, '/api/v3/command': ACCEPTED })
    const session = metadataSession(net, EVERYTHING)

    /*
     * The source path, not the repaired one. Radarr's record still points at
     * the `.mkv` that has just been replaced, so that is the only path it can
     * be found by; after the rescan it will know about the `.mp4`.
     */
    const told = await session.tellTheLibrary('movie', FILM)
    if (told === undefined || isProblem(told)) throw new Error('expected an announcement')

    expect(told).toEqual({ service: 'radarr', name: 'Radarr', title: 'Solaris' })
    expect(net.posted).toEqual([{ name: 'RescanMovie', movieId: 11 }])
  })

  it('asks Sonarr about an episode, by the series the file is under', async () => {
    const net = transport({ '/api/v3/series': SONARR_SERIES, '/api/v3/command': { id: 902, status: 'queued' } })
    const told = await metadataSession(net, EVERYTHING).tellTheLibrary('tv', EPISODE)
    if (told === undefined || isProblem(told)) throw new Error('expected an announcement')

    expect(told.service).toBe('sonarr')
    expect(net.posted).toEqual([{ name: 'RescanSeries', seriesId: 7 }])
  })

  it('says nothing, and writes nothing, for a file no manager has heard of', async () => {
    const net = transport({ '/api/v3/movie': RADARR })
    const told = await metadataSession(net, EVERYTHING).tellTheLibrary('movie', '/elsewhere/Solaris.mkv')

    // Not a failure: a file imported by hand is an ordinary thing to have.
    expect(told).toBeUndefined()
    expect(net.posted).toEqual([])
  })

  it('never acts on a database match, which is a guess at a name', async () => {
    /*
     * A rescan is a write. themoviedb.org can say a film of roughly this name
     * exists; it cannot say which film is on this disk, and its id would mean
     * nothing to Radarr anyway. Three things stop it and any one would do: it
     * cannot match a path, it is never handed a title here to match on
     * instead, and it has no rescan command for the compiler to accept. What
     * is asserted is the outcome — nothing is asked and nothing is written.
     */
    const net = transport({ 'themoviedb.org': TMDB_SEARCH, '/api/v3/command': ACCEPTED })
    const onlyTmdb = { ...EVERYTHING, metadataProviders: ['tmdb'] }
    expect(await metadataSession(net, onlyTmdb).tellTheLibrary('movie', FILM)).toBeUndefined()
    expect(net.asked).toEqual([])
  })

  it('reports a refusal rather than swallowing it', async () => {
    // A library quietly left out of date is the thing this exists to prevent,
    // so a command that was not accepted has to be worth saying out loud.
    const net = transport({ '/api/v3/movie': RADARR })
    const told = await metadataSession(net, EVERYTHING).tellTheLibrary('movie', FILM)
    expect(told !== undefined && isProblem(told) && told.problem).toContain('404')
  })

  it('reuses the library listing a lookup already fetched', async () => {
    const net = transport({ '/api/v3/movie': RADARR, '/api/v3/command': ACCEPTED })
    const session = metadataSession(net, EVERYTHING)

    await session.lookUp({ kind: 'movie', filePath: FILM })
    await session.tellTheLibrary('movie', FILM)
    expect(net.asked.filter((url) => url.includes('/api/v3/movie'))).toHaveLength(1)
  })
})
