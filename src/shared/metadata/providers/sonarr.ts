/**
 * Sonarr, as a provider.
 *
 * The same idea as Radarr and a longer road to it, because a series is two
 * things: the series, and the episode of it somebody has. Sonarr's library
 * call answers the first; the episodes of one series are a second call.
 *
 * So this is a two-step provider. `search` asks for the series list and
 * matches the file's path against each series folder — the part of the path
 * both systems agree on. `details` then asks for that series' episodes and
 * finds the one whose file is this file, which is better than counting on the
 * season and episode numbers read out of the name: Sonarr knows which file it
 * put where, and a file named `S02E06` that is actually the seventh episode is
 * a real and common thing.
 *
 * Written against Sonarr's own OpenAPI document (`src/Sonarr.Api.V3/
 * openapi.json` in the Sonarr repository): `SeriesResource`, `EpisodeResource`,
 * the `seriesId`/`includeEpisodeFile` parameters and the `X-Api-Key` header
 * all come from there.
 */

import type { MetadataMatch, MetadataProvider, ServiceCredential } from './types.js'
import { asArray, asNumber, asRecord, asText, baseUrl, readJson, isProblem } from './types.js'
import { pathTail, samePath } from './radarr.js'

export const SONARR_ID = 'sonarr'

/** Whether a file lies anywhere under a series folder. */
export function underFolder(folder: string | undefined, file: string | undefined): boolean {
  if (!folder || !file) return false
  const tidy = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const name = tidy(folder).split('/').pop()
  if (!name) return false
  // Matched on the folder's own name rather than the whole path, so a library
  // mounted somewhere else here than in Sonarr still lines up.
  return tidy(file).split('/').includes(name)
}

function header(credential: ServiceCredential): Record<string, string> {
  return { 'X-Api-Key': credential.apiKey ?? '', Accept: 'application/json' }
}

function ready(credential: ServiceCredential): { base: string } | { problem: string; hint?: string; needsLogin?: boolean } {
  const base = baseUrl(credential.url)
  if (!base) return { problem: 'No Sonarr address.', hint: 'Set one under Services in Settings.', needsLogin: true }
  if (!credential.apiKey) {
    return { problem: 'No Sonarr API key.', hint: 'Settings → General → Security in Sonarr.', needsLogin: true }
  }
  return { base }
}

export const sonarr: MetadataProvider = {
  id: SONARR_ID,
  name: 'Sonarr',
  site: 'https://sonarr.tv',
  needs: 'url-and-api-key',
  summary: 'Your own series library. Knows which episode a file is, rather than reading it off the name.',
  kinds: ['tv'],
  matchesByPath: true,

  search(query, credential) {
    const state = ready(credential)
    if ('problem' in state) return state
    if (query.kind !== 'tv') return { problem: 'Sonarr only knows about series; this is a film.' }
    return { url: `${state.base}/api/v3/series`, headers: header(credential) }
  },

  readSearch(reply, query) {
    if (reply.status === 401) {
      return { problem: 'Sonarr rejected the API key.', hint: 'Check it under Services in Settings.', needsLogin: true }
    }
    if (reply.status >= 400) return { problem: `Sonarr answered ${reply.status}.` }

    const body = readJson(reply, 'Sonarr')
    if (isProblem(body)) return body

    const matches: MetadataMatch[] = []
    for (const entry of asArray(body)) {
      const series = asRecord(entry)
      const title = series && asText(series.title)
      if (!series || !title) continue

      matches.push({
        provider: SONARR_ID,
        id: String(asNumber(series.id) ?? ''),
        kind: 'tv',
        title,
        year: asNumber(series.year) ? String(asNumber(series.year)) : undefined,
        date: asText(series.firstAired),
        overview: asText(series.overview),
        genres: asArray(series.genres).map(asText).filter((g): g is string => Boolean(g)),
        imdbId: asText(series.imdbId),
        tmdbId: asNumber(series.tmdbId),
        tvdbId: asNumber(series.tvdbId),
        season: query.season,
        episode: query.episode,
        filePath: query.filePath,
        pathMatch: underFolder(asText(series.path), query.filePath)
      })
    }

    const exact = matches.filter((match) => match.pathMatch)
    if (exact.length > 0) return exact
    if (query.filePath) {
      return {
        problem: 'Sonarr has no series holding that file.',
        hint: 'It may not have been imported, or it may be under a different mount point here than in Sonarr.'
      }
    }
    return matches
  },

  /**
   * The episodes of the matched series, with their files.
   *
   * `includeEpisodeFile` is what makes the second half of this possible: the
   * reply carries each episode's path, so the episode can be found by which
   * file it is rather than by the numbers in the name.
   */
  details(match, credential) {
    const state = ready(credential)
    if ('problem' in state) return state
    const id = Number(match.id)
    if (!Number.isFinite(id)) return { problem: `Not a Sonarr series id: ${match.id}` }
    return {
      url: `${state.base}/api/v3/episode?seriesId=${id}&includeEpisodeFile=true`,
      headers: header(credential)
    }
  },

  readDetails(reply, match) {
    if (reply.status >= 400) return { problem: `Sonarr answered ${reply.status}.` }
    const body = readJson(reply, 'Sonarr')
    if (isProblem(body)) return body

    const episodes = asArray(body)
      .map(asRecord)
      .filter((episode): episode is Record<string, unknown> => episode !== undefined)

    // The file first, the numbers second. Sonarr recorded which file it put
    // where, so a file whose name says S02E06 but which Sonarr imported as the
    // seventh episode is resolved correctly here and nowhere else.
    const byPath = episodes.find((episode) => {
      const file = asRecord(episode.episodeFile)
      const path = asText(file?.path)
      return samePath(path, match.filePath) || pathTail(path) === pathTail(match.filePath)
    })

    const byNumber =
      match.season != null && match.episode != null
        ? episodes.find(
            (episode) =>
              asNumber(episode.seasonNumber) === match.season && asNumber(episode.episodeNumber) === match.episode
          )
        : undefined

    const found = byPath ?? byNumber
    if (!found) {
      return { problem: 'Sonarr lists no episode for that file, and none at that season and number.' }
    }

    return {
      ...match,
      season: asNumber(found.seasonNumber) ?? match.season,
      episode: asNumber(found.episodeNumber) ?? match.episode,
      episodeTitle: asText(found.title),
      overview: asText(found.overview) ?? match.overview,
      date: asText(found.airDate) ?? match.date,
      pathMatch: byPath !== undefined
    }
  }
}
