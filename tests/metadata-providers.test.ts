/**
 * The metadata providers, against replies shaped like the real ones.
 *
 * The bodies here follow Radarr's and Sonarr's published OpenAPI documents —
 * `MovieResource`, `SeriesResource`, `EpisodeResource` — cut down to the
 * fields these providers read. Testing a provider against a saved reply is the
 * only honest way to test one; the alternative is finding out what a service
 * sends from somebody's library.
 */

import { describe, expect, it } from 'vitest'
import {
  METADATA_PROVIDERS,
  isProblem,
  metadataProviderById,
  preferred,
  radarr,
  sonarr,
  tmdb
} from '@shared/metadata/providers/index.js'
import { baseUrl } from '@shared/metadata/providers/types.js'
import { pathTail, samePath } from '@shared/metadata/providers/radarr.js'
import { underFolder } from '@shared/metadata/providers/sonarr.js'
import type { HttpReply, MetadataQuery } from '@shared/metadata/providers/types.js'

const KEY = { apiKey: 'abc123', url: 'http://nas:7878/' }

function ok(body: unknown): HttpReply {
  return { status: 200, text: JSON.stringify(body) }
}

const MOVIE = {
  id: 42,
  title: 'Dune',
  year: 2021,
  releaseDate: '2021-10-22',
  overview: 'Paul Atreides.',
  genres: ['Science Fiction', 'Adventure'],
  imdbId: 'tt1160419',
  tmdbId: 438631,
  path: '/data/Films/Dune (2021)',
  movieFile: { id: 7, path: '/data/Films/Dune (2021)/Dune (2021) Bluray-2160p.mkv' }
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

describe('the provider list', () => {
  it('gives every provider a distinct id', () => {
    const ids = METADATA_PROVIDERS.map((provider) => provider.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('finds one by id, and nothing by a name that is not one', () => {
    expect(metadataProviderById('radarr')).toBe(radarr)
    expect(metadataProviderById('imdb')).toBeUndefined()
  })

  /*
   * The whole ordering rule in one assertion: the thing that put the file
   * there is asked before the database that has never seen it.
   */
  it('asks what knows the file before what has to guess at it', () => {
    expect(preferred('movie', ['tmdb', 'radarr']).map((p) => p.id)).toEqual(['radarr', 'tmdb'])
    expect(preferred('tv', ['tmdb', 'sonarr']).map((p) => p.id)).toEqual(['sonarr', 'tmdb'])
  })

  it('leaves out a provider that cannot answer about this kind', () => {
    expect(preferred('tv', ['radarr', 'tmdb']).map((p) => p.id)).toEqual(['tmdb'])
    expect(preferred('movie', ['sonarr', 'tmdb']).map((p) => p.id)).toEqual(['tmdb'])
  })

  it('leaves out a provider that is switched off', () => {
    expect(preferred('movie', ['tmdb']).map((p) => p.id)).toEqual(['tmdb'])
    expect(preferred('movie', [])).toEqual([])
  })
})

describe('baseUrl', () => {
  it('takes the trailing slash off', () => {
    expect(baseUrl('http://nas:7878/')).toBe('http://nas:7878')
  })

  /*
   * The one that matters. Radarr's own address bar reads
   * `http://nas:7878/#/movies`, so that is what gets pasted — and everything
   * after a `#` is never sent, so every request would silently go to the root
   * and come back as the web UI's HTML.
   */
  it('cuts a fragment off, because a fragment is never sent', () => {
    expect(baseUrl('http://nas:7878/#/movies')).toBe('http://nas:7878')
  })

  it('answers nothing for nothing', () => {
    expect(baseUrl(undefined)).toBeUndefined()
    expect(baseUrl('   ')).toBeUndefined()
    expect(baseUrl('/')).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * Radarr
 * ------------------------------------------------------------------ */

describe('radarr', () => {
  const query: MetadataQuery = { kind: 'movie', filePath: '/data/Films/Dune (2021)/Dune (2021) Bluray-2160p.mkv' }

  it('asks for the library, with the key in the header Radarr documents', () => {
    const request = radarr.search(query, KEY)
    expect(isProblem(request)).toBe(false)
    if (isProblem(request)) return
    expect(request.url).toBe('http://nas:7878/api/v3/movie')
    expect(request.headers?.['X-Api-Key']).toBe('abc123')
  })

  it('narrows to one film when something already knows the TMDB id', () => {
    const request = radarr.search({ ...query, tmdbId: 438631 }, KEY)
    if (isProblem(request)) throw new Error(request.problem)
    expect(request.url).toBe('http://nas:7878/api/v3/movie?tmdbId=438631')
  })

  it('refuses an episode rather than answering about one', () => {
    expect(isProblem(radarr.search({ kind: 'tv' }, KEY))).toBe(true)
  })

  it('says which setting is missing', () => {
    const noUrl = radarr.search(query, { apiKey: 'x' })
    const noKey = radarr.search(query, { url: 'http://nas:7878' })
    expect(isProblem(noUrl) && noUrl.needsLogin).toBe(true)
    expect(isProblem(noKey) && noKey.needsLogin).toBe(true)
  })

  it('reads the film it placed, and says it matched the file itself', () => {
    const found = radarr.readSearch(ok([MOVIE]), query)
    if (isProblem(found)) throw new Error(found.problem)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      provider: 'radarr',
      title: 'Dune',
      year: '2021',
      tmdbId: 438631,
      imdbId: 'tt1160419',
      pathMatch: true
    })
    expect(found[0].genres).toEqual(['Science Fiction', 'Adventure'])
  })

  /*
   * The case this is actually for. Radarr runs in a container that sees
   * `/data`, and the same library is `/Volumes/media` here. Comparing the
   * whole path finds nothing; the film's own folder and file name are what
   * both systems agree on.
   */
  it('matches the same file under a different mount point', () => {
    const found = radarr.readSearch(ok([MOVIE]), {
      kind: 'movie',
      filePath: '/Volumes/media/Films/Dune (2021)/Dune (2021) Bluray-2160p.mkv'
    })
    if (isProblem(found)) throw new Error(found.problem)
    expect(found[0].pathMatch).toBe(true)
  })

  it('hands back one answer rather than the whole library when it has one', () => {
    const other = { ...MOVIE, id: 9, title: 'Arrival', tmdbId: 329865, movieFile: { path: '/data/Films/Arrival (2016)/Arrival (2016).mkv' } }
    const found = radarr.readSearch(ok([other, MOVIE]), query)
    if (isProblem(found)) throw new Error(found.problem)
    expect(found.map((m) => m.title)).toEqual(['Dune'])
  })

  /*
   * A library of four hundred films is not a list of candidates for one file.
   * Saying "Radarr has not got this" is the useful answer; handing back
   * everything it does have is not.
   */
  it('says it does not know the file rather than returning the whole library', () => {
    const found = radarr.readSearch(ok([MOVIE]), { kind: 'movie', filePath: '/data/Films/Heat (1995)/Heat (1995).mkv' })
    expect(isProblem(found)).toBe(true)
    if (isProblem(found)) expect(found.problem).toContain('no film at that path')
  })

  it('reports a rejected key as something to go and fix', () => {
    const found = radarr.readSearch({ status: 401 }, query)
    expect(isProblem(found) && found.needsLogin).toBe(true)
  })

  it('survives a reply that is not JSON at all', () => {
    const found = radarr.readSearch({ status: 200, text: '<!doctype html><html>…' }, query)
    expect(isProblem(found)).toBe(true)
  })

  it('skips a malformed entry instead of losing the good ones beside it', () => {
    const found = radarr.readSearch(ok([null, 'nonsense', { id: 1 }, MOVIE]), query)
    if (isProblem(found)) throw new Error(found.problem)
    expect(found.map((m) => m.title)).toEqual(['Dune'])
  })
})

describe('path comparison', () => {
  it('treats the two slash directions as the same', () => {
    expect(samePath('C:\\Films\\x.mkv', 'C:/Films/x.mkv')).toBe(true)
  })

  it('ignores case, which Windows and macOS both do', () => {
    expect(samePath('/films/X.MKV', '/Films/x.mkv')).toBe(true)
  })

  it('is false when either side has nothing', () => {
    expect(samePath(undefined, '/a')).toBe(false)
    expect(samePath('/a', undefined)).toBe(false)
  })

  it('reduces a path to the folder and file both systems agree on', () => {
    expect(pathTail('/data/Films/Dune (2021)/Dune (2021).mkv')).toBe('dune (2021)/dune (2021).mkv')
    expect(pathTail(undefined)).toBeUndefined()
  })

  it('finds a file under a series folder wherever that folder is mounted', () => {
    expect(underFolder('/data/TV/Severance', '/Volumes/media/TV/Severance/Season 1/S01E01.mkv')).toBe(true)
    expect(underFolder('/data/TV/Severance', '/Volumes/media/TV/The Expanse/Season 1/S01E01.mkv')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * Sonarr
 * ------------------------------------------------------------------ */

const SERIES = {
  id: 3,
  title: 'Severance',
  year: 2022,
  firstAired: '2022-02-18',
  overview: 'Work-life balance.',
  genres: ['Drama'],
  imdbId: 'tt11280740',
  tvdbId: 371980,
  path: '/data/TV/Severance'
}

describe('sonarr', () => {
  const file = '/data/TV/Severance/Season 1/Severance - S01E01 - Good News About Hell.mkv'
  const query: MetadataQuery = { kind: 'tv', filePath: file, season: 1, episode: 1 }

  it('asks for the series list', () => {
    const request = sonarr.search(query, KEY)
    if (isProblem(request)) throw new Error(request.problem)
    expect(request.url).toBe('http://nas:7878/api/v3/series')
  })

  it('refuses a film', () => {
    expect(isProblem(sonarr.search({ kind: 'movie' }, KEY))).toBe(true)
  })

  it('finds the series holding the file and carries the file forward', () => {
    const found = sonarr.readSearch(ok([SERIES]), query)
    if (isProblem(found)) throw new Error(found.problem)
    expect(found[0]).toMatchObject({ title: 'Severance', tvdbId: 371980, pathMatch: true, filePath: file })
  })

  it('asks for that series\u2019 episodes with their files attached', () => {
    const found = sonarr.readSearch(ok([SERIES]), query)
    if (isProblem(found)) throw new Error(found.problem)
    const request = sonarr.details!(found[0], KEY)
    if (isProblem(request)) throw new Error(request.problem)
    expect(request.url).toBe('http://nas:7878/api/v3/episode?seriesId=3&includeEpisodeFile=true')
  })

  /*
   * The reason Sonarr beats reading the name. This file is called S01E01 and
   * Sonarr imported it as episode 2 — which happens whenever a release is
   * numbered differently from the series' own ordering. Sonarr knows which
   * file it put where; the name does not.
   */
  it('believes the file Sonarr placed over the numbers in its name', () => {
    const found = sonarr.readSearch(ok([SERIES]), query)
    if (isProblem(found)) throw new Error(found.problem)
    const episodes = [
      { seasonNumber: 1, episodeNumber: 1, title: 'Wrong One', episodeFile: { path: '/data/TV/Severance/Season 1/other.mkv' } },
      { seasonNumber: 1, episodeNumber: 2, title: 'Half Loop', overview: 'Mark.', airDate: '2022-02-18', episodeFile: { path: file } }
    ]
    const details = sonarr.readDetails!(ok(episodes), found[0])
    if (isProblem(details)) throw new Error(details.problem)
    expect(details.episode).toBe(2)
    expect(details.episodeTitle).toBe('Half Loop')
    expect(details.pathMatch).toBe(true)
  })

  it('falls back to the season and episode numbers when no file matches', () => {
    const found = sonarr.readSearch(ok([SERIES]), query)
    if (isProblem(found)) throw new Error(found.problem)
    const episodes = [{ seasonNumber: 1, episodeNumber: 1, title: 'Good News About Hell' }]
    const details = sonarr.readDetails!(ok(episodes), found[0])
    if (isProblem(details)) throw new Error(details.problem)
    expect(details.episodeTitle).toBe('Good News About Hell')
    expect(details.pathMatch).toBe(false)
  })

  it('says so when it has neither', () => {
    const found = sonarr.readSearch(ok([SERIES]), query)
    if (isProblem(found)) throw new Error(found.problem)
    expect(isProblem(sonarr.readDetails!(ok([]), found[0]))).toBe(true)
  })

  it('says it does not hold the file rather than listing every series', () => {
    const found = sonarr.readSearch(ok([SERIES]), { kind: 'tv', filePath: '/data/TV/The Expanse/S01E01.mkv' })
    expect(isProblem(found)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * TMDB, which is the same interface over the module that already existed
 * ------------------------------------------------------------------ */

describe('tmdb as a provider', () => {
  it('needs a title, having no idea what a path is', () => {
    expect(isProblem(tmdb.search({ kind: 'movie', filePath: '/x/y.mkv' }, { apiKey: 'k'.repeat(32) }))).toBe(true)
  })

  it('builds a search from the guessed title and year', () => {
    const request = tmdb.search({ kind: 'movie', title: 'Dune', year: '2021' }, { apiKey: 'k'.repeat(32) })
    if (isProblem(request)) throw new Error(request.problem)
    expect(request.url).toContain('search/movie')
    expect(request.url).toContain('query=Dune')
    expect(request.url).toContain('year=2021')
  })

  it('sends a read-access token in a header, never in the query string', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ4In0.signature'
    const request = tmdb.search({ kind: 'movie', title: 'Dune' }, { apiKey: token })
    if (isProblem(request)) throw new Error(request.problem)
    expect(request.headers?.Authorization).toBe(`Bearer ${token}`)
    expect(request.url).not.toContain(token)
  })

  it('never claims a path match, because it cannot have made one', () => {
    const found = tmdb.readSearch(
      ok({ results: [{ id: 438631, title: 'Dune', release_date: '2021-10-22', overview: 'Paul.' }] }),
      { kind: 'movie', title: 'Dune' }
    )
    if (isProblem(found)) throw new Error(found.problem)
    expect(found[0].pathMatch).toBe(false)
    expect(found[0].tmdbId).toBe(438631)
  })

  it('reports a rejected key as something to go and fix', () => {
    const found = tmdb.readSearch({ status: 401 }, { kind: 'movie', title: 'Dune' })
    expect(isProblem(found) && found.needsLogin).toBe(true)
  })
})
