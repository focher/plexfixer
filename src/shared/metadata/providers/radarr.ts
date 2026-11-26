/**
 * Radarr, as a provider — and the reason this list exists.
 *
 * Radarr put the file where it is. It knows which film it is without being
 * asked to guess, because it was the thing that decided: the path on disk is
 * recorded against the film it downloaded. So where TMDB is handed
 * `the.movie.2019.1080p.x264.mkv` and asked what that might be, Radarr is
 * handed the path and answers with certainty, carrying the TMDB id with it.
 *
 * Written against Radarr's own OpenAPI document (`src/Radarr.Api.V3/
 * openapi.json` in the Radarr repository), not against a guess: the shape of
 * `MovieResource`, the `X-Api-Key` header and the `tmdbId` query parameter all
 * come from there.
 *
 * `GET /api/v3/movie` returns the whole library in one reply, which is a few
 * megabytes for a large one. That is the only call Radarr offers that can
 * match a path — there is no "which film is this file" endpoint — and it is
 * one request rather than a search per file, so it is the cheaper shape
 * despite the size.
 */

import type { MetadataMatch, MetadataProvider } from './types.js'
import { asArray, asNumber, asRecord, asText, baseUrl, readJson, isProblem } from './types.js'

export const RADARR_ID = 'radarr'

/** Path comparison that survives the ways two systems spell the same file. */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const tidy = (path: string): string =>
    path
      // Radarr on Windows says `C:\Films\x.mkv`; a path from here may use
      // either separator, and a share may be mounted under a different root.
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase()
  return tidy(a) === tidy(b)
}

/**
 * The last two segments of a path, which is what survives a different mount.
 *
 * The same library is `/mnt/media/Films/Dune (2021)/Dune (2021).mkv` to Radarr
 * in a container and `/Volumes/media/Films/Dune (2021)/Dune (2021).mkv` here.
 * The film's own folder and file name are the part both agree on.
 */
export function pathTail(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0) return undefined
  return parts.slice(-2).join('/').toLowerCase()
}

export const radarr: MetadataProvider = {
  id: RADARR_ID,
  name: 'Radarr',
  site: 'https://radarr.video',
  needs: 'url-and-api-key',
  summary: 'Your own film library. Identifies a file by where it is rather than by what it is called.',
  kinds: ['movie'],
  matchesByPath: true,

  search(query, credential) {
    const base = baseUrl(credential.url)
    if (!base) {
      return { problem: 'No Radarr address.', hint: 'Set one under Services in Settings.', needsLogin: true }
    }
    if (!credential.apiKey) {
      return { problem: 'No Radarr API key.', hint: 'Settings → General → Security in Radarr.', needsLogin: true }
    }
    if (query.kind !== 'movie') {
      return { problem: 'Radarr only knows about films; this is an episode.' }
    }

    // A tmdbId narrows the reply to one film, which is worth doing whenever
    // something already knows it. Otherwise the whole library comes back and
    // the match is made here, against the path.
    const url =
      query.tmdbId != null
        ? `${base}/api/v3/movie?tmdbId=${encodeURIComponent(String(query.tmdbId))}`
        : `${base}/api/v3/movie`

    return { url, headers: { 'X-Api-Key': credential.apiKey, Accept: 'application/json' } }
  },

  readSearch(reply, query) {
    if (reply.status === 401) {
      return { problem: 'Radarr rejected the API key.', hint: 'Check it under Services in Settings.', needsLogin: true }
    }
    if (reply.status >= 400) return { problem: `Radarr answered ${reply.status}.` }

    const body = readJson(reply, 'Radarr')
    if (isProblem(body)) return body

    const wantedTail = pathTail(query.filePath)
    const matches: MetadataMatch[] = []

    for (const entry of asArray(body)) {
      const movie = asRecord(entry)
      if (!movie) continue

      const file = asRecord(movie.movieFile)
      const filePath = asText(file?.path)
      // Radarr reports the film's folder and, separately, the file in it.
      // Either can be what we are holding: a film kept loose in a folder of
      // its own matches on the folder, and the file matches on the file.
      const pathMatch =
        samePath(filePath, query.filePath) ||
        pathTail(filePath) === wantedTail ||
        (wantedTail !== undefined && pathTail(asText(movie.path)) === wantedTail?.split('/')[0])

      const title = asText(movie.title)
      if (!title) continue

      const id = asNumber(movie.id)
      matches.push({
        provider: RADARR_ID,
        id: String(id ?? ''),
        kind: 'movie',
        title,
        year: asNumber(movie.year) ? String(asNumber(movie.year)) : undefined,
        date: asText(movie.releaseDate) ?? asText(movie.physicalRelease) ?? asText(movie.inCinemas),
        overview: asText(movie.overview),
        genres: asArray(movie.genres).map(asText).filter((g): g is string => Boolean(g)),
        imdbId: asText(movie.imdbId),
        tmdbId: asNumber(movie.tmdbId),
        filePath: query.filePath,
        pathMatch: Boolean(pathMatch)
      })
    }

    /*
     * A path match is an answer; everything else is a list.
     *
     * When Radarr has placed this exact file, there is nothing to choose
     * between — offering the other four hundred films in the library beside it
     * would be absurd. Without one, the whole library is the wrong thing to
     * hand back, so it is refused rather than dumped on the caller: Radarr
     * does not know this file, and saying so is the useful answer.
     */
    const exact = matches.filter((match) => match.pathMatch)
    if (exact.length > 0) return exact
    if (query.tmdbId != null) return matches
    if (query.filePath) {
      return { problem: 'Radarr has no film at that path.', hint: 'It may not have been imported, or it may be under a different mount point here than in Radarr.' }
    }
    return matches
  }
}
