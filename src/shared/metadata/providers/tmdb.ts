/**
 * The Movie Database, as a provider.
 *
 * The addresses and the reply readers already existed in `shared/tmdb.ts` and
 * are not duplicated here: this wraps them in the provider shape so TMDB sits
 * in the same list as everything else. That file stays the place TMDB's wire
 * format is described, because it is also what the metadata dialog has always
 * called directly.
 *
 * TMDB matches on a title guessed out of a file name, which is the step that
 * gets a film wrong — two films of the same name in the same year, a release
 * name the guesser did not fully strip. It is still the right default: it is
 * the only one of these that works for somebody who runs no library manager.
 */

import type { MetadataMatch, MetadataProvider, MetadataQuery, ServiceCredential } from './types.js'
import { isProblem } from './types.js'
import {
  detailsUrl,
  episodeUrl,
  parseDetails,
  parseEpisode,
  parseSearch,
  readCredential,
  searchUrl,
  authHeader
} from '../../tmdb.js'

export const TMDB_ID = 'tmdb'

function asMatch(match: { id: number; title: string; year?: string; date?: string; overview: string; genres?: string[] }, kind: MetadataQuery['kind']): MetadataMatch {
  return {
    provider: TMDB_ID,
    id: String(match.id),
    kind,
    title: match.title,
    year: match.year,
    date: match.date,
    overview: match.overview || undefined,
    genres: match.genres,
    tmdbId: match.id,
    // Never: TMDB has never seen this machine.
    pathMatch: false
  }
}

export const tmdb: MetadataProvider = {
  id: TMDB_ID,
  name: 'The Movie Database',
  site: 'https://www.themoviedb.org/settings/api',
  needs: 'api-key',
  summary: 'The database most libraries are named from. Matches on the title guessed from the file name.',
  kinds: ['movie', 'tv'],
  matchesByPath: false,

  search(query, credential) {
    const key = readCredential(credential.apiKey ?? '')
    if (!key) return { problem: 'No TMDB key.', hint: 'Paste one under Metadata in Settings.', needsLogin: true }
    if (!query.title) return { problem: 'Nothing to search TMDB for — no title could be read from the file name.' }
    return {
      url: searchUrl(key, query.kind, query.title, query.year),
      headers: authHeader(key) ? { Authorization: authHeader(key)! } : undefined
    }
  },

  readSearch(reply, query) {
    if (reply.status === 401) {
      return { problem: 'TMDB rejected the key.', hint: 'Check it under Metadata in Settings.', needsLogin: true }
    }
    if (reply.status >= 400) return { problem: `TMDB answered ${reply.status}.` }
    return parseSearch(reply.text ?? '', query.kind).map((match) => asMatch(match, query.kind))
  },

  details(match, credential) {
    const key = readCredential(credential.apiKey ?? '')
    if (!key) return { problem: 'No TMDB key.', needsLogin: true }
    const id = Number(match.id)
    if (!Number.isFinite(id)) return { problem: `Not a TMDB id: ${match.id}` }

    // An episode is a third call, not a deeper one: the series details say
    // nothing about the episode somebody actually has.
    if (match.kind === 'tv' && match.season != null && match.episode != null) {
      return {
        url: episodeUrl(key, id, match.season, match.episode),
        headers: authHeader(key) ? { Authorization: authHeader(key)! } : undefined
      }
    }
    return {
      url: detailsUrl(key, match.kind, id),
      headers: authHeader(key) ? { Authorization: authHeader(key)! } : undefined
    }
  },

  readDetails(reply, match) {
    if (reply.status >= 400) return { problem: `TMDB answered ${reply.status}.` }
    const body = reply.text ?? ''

    if (match.kind === 'tv' && match.season != null && match.episode != null) {
      const episode = parseEpisode(body)
      if (!episode) return { problem: 'TMDB sent no episode for that season and number.' }
      return { ...match, episodeTitle: episode.title, overview: episode.overview || match.overview, date: episode.date ?? match.date }
    }

    const details = parseDetails(body, match.kind)
    if (!details) return { problem: 'TMDB sent nothing readable for that id.' }
    return { ...asMatch(details, match.kind), season: match.season, episode: match.episode }
  }
}

/** Kept honest by the compiler: a credential with a URL is still a credential. */
export type TmdbCredentialShape = ServiceCredential

export { isProblem }
