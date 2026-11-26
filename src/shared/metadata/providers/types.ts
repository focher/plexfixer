/**
 * What a metadata service has to be able to do, and nothing about how.
 *
 * The same boundary the subtitle providers sit behind, for the same reasons:
 * a provider describes requests and reads replies, and never performs one.
 * `../../providers/http.js` holds that boundary and is re-exported here, so a
 * provider has one import.
 *
 * The difference worth naming is *how a file is identified*. A database like
 * TMDB knows nothing about this machine, so it has to be asked about a title
 * guessed out of a file name — which is the step that gets a film wrong. A
 * library manager already has the file: Radarr was told to put it where it is
 * and knows exactly which film it is. So a provider says which of the two it
 * is, and one that matches by path is preferred where both could answer,
 * because a path is a fact and a guessed title is a guess.
 */

export * from '../../providers/http.js'
import type { HttpReply, HttpRequest, ProviderCredential, ProviderProblem } from '../../providers/http.js'

/** A film or a series — the two things a library holds. */
export type MetadataKind = 'movie' | 'tv'

/**
 * What is known about the file, as far as identifying it goes.
 *
 * Everything but `kind` is optional, because every service matches on a
 * different subset and because the app genuinely may not know: a file called
 * `movie.mkv` with no tags has nothing but where it sits on disk.
 */
export interface MetadataQuery {
  kind: MetadataKind
  /**
   * Where the file is, which a library manager knows it by.
   *
   * The single most useful field here when one is available, and meaningless
   * to a database that has never seen this machine.
   */
  filePath?: string
  /** The title, as the naming rules guessed it from the file name. */
  title?: string
  /** Four digits, when something suggested one. */
  year?: string
  season?: number
  episode?: number
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
}

/** One thing a service says this might be. */
export interface MetadataMatch {
  /** Which provider found it; the id below means nothing to any other. */
  provider: string
  /** The provider's own id for it, for a details call. */
  id: string
  kind: MetadataKind
  title: string
  /** Four digits, when the service knows. */
  year?: string
  /** The full release or air date, where there is one. */
  date?: string
  overview?: string
  genres?: string[]
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  /** Series and episode titles differ; this is the episode's own. */
  episodeTitle?: string
  season?: number
  episode?: number
  /**
   * The service matched this against the file itself, not against a name.
   *
   * The same distinction `SubtitleCandidate.hashMatch` draws, and as decisive:
   * a path match is the library manager saying "this file is that film", where
   * a title match is a database saying "something of roughly that name exists".
   */
  pathMatch: boolean
  /**
   * The file this match was made against, carried forward from the query.
   *
   * A details call for a series needs it: the episodes come back with their
   * own paths, and finding the one that is *this* file is better than trusting
   * the season and episode numbers in its name.
   */
  filePath?: string
}

/**
 * A metadata service.
 *
 * `search` may answer with a refusal rather than a request — a film-only
 * service asked about an episode, or a library manager asked about a path it
 * was never given. That is an ordinary answer and not an error.
 *
 * Some services answer everything in the search reply and some hold the
 * details back, so `details` is optional: without it, what `readSearch`
 * returned is all there is.
 */
export interface MetadataProvider {
  /** Stable id, stored in settings; never renamed once shipped. */
  readonly id: string
  readonly name: string
  /** Where to go to get a credential, or to find the service. */
  readonly site: string
  readonly needs: 'nothing' | 'api-key' | 'url-and-api-key'
  /** One line under the switch in Settings. */
  readonly summary: string
  /** Which kinds it can answer about at all. */
  readonly kinds: readonly MetadataKind[]
  /**
   * True when it identifies a file by where it is rather than by its name.
   *
   * What makes a provider worth asking first.
   */
  readonly matchesByPath: boolean

  search(query: MetadataQuery, credential: ServiceCredential): HttpRequest | ProviderProblem
  readSearch(reply: HttpReply, query: MetadataQuery): MetadataMatch[] | ProviderProblem

  details?(match: MetadataMatch, credential: ServiceCredential): HttpRequest | ProviderProblem
  readDetails?(reply: HttpReply, match: MetadataMatch): MetadataMatch | ProviderProblem
}

/**
 * Whatever a service needs to be reachable, beyond a credential.
 *
 * A database lives at an address written into this app. A library manager
 * lives wherever the person running it put it, so its address is part of what
 * it takes to talk to it at all.
 */
export interface ServiceCredential extends ProviderCredential {
  /** The service's own address, for one that is not at a fixed one. */
  url?: string
}

/**
 * Trim a base URL to something requests can be built on.
 *
 * People paste `http://nas:7878/`, `http://nas:7878` and `http://nas:7878/#/`
 * interchangeably, and two of those produce a double slash or a fragment in
 * the middle of every request. The fragment matters most: everything after a
 * `#` is never sent, so a URL carrying one silently requests the root.
 */
export function baseUrl(url: string | undefined): string | undefined {
  const trimmed = (url ?? '').trim()
  if (trimmed === '') return undefined
  const withoutFragment = trimmed.split('#')[0]
  const withoutTrailingSlash = withoutFragment.replace(/\/+$/, '')
  return withoutTrailingSlash === '' ? undefined : withoutTrailingSlash
}
