/**
 * Asking the metadata services, in the order of how much they know.
 *
 * The providers beside this describe requests and read replies and perform
 * nothing. This is the part that performs them, and the part that decides who
 * is asked: a provider that identifies a file by where it is comes before one
 * that identifies it by what it is called, because Radarr put the file there
 * and themoviedb.org is being handed `the.movie.2019.1080p.x264.mkv` and asked
 * to guess.
 *
 * Asking in that order is not the same as asking only the first one. Radarr
 * does not have every file — something imported by hand, something Radarr was
 * never told about — and "Radarr has not heard of this" is an ordinary answer
 * and not a failure. So each provider in turn is asked until one answers, and
 * only if none of them does is anything reported as a problem, with what each
 * of them said.
 *
 * A session rather than a function because of the one thing a per-file loop
 * gets catastrophically wrong: Radarr's only way to match a path is to return
 * the whole library, and eighty files would be eighty copies of it. Within one
 * session an identical GET is made once. A library does not change while a
 * dialog is open, and if it did, the answer wanted is the one the rest of the
 * run used.
 */

import type { AppSettings } from '../types.js'
import { METADATA_PROVIDERS, preferred } from './providers/index.js'
import type {
  HttpReply,
  HttpRequest,
  MetadataMatch,
  MetadataProvider,
  MetadataQuery,
  ProviderProblem,
  ServiceCredential
} from './providers/types.js'
import { isProblem } from './providers/types.js'
import { readRescan, rescanRequest, type RescanService } from './rescan.js'

/** The transport, which is a Tauri command on the other side of this. */
export interface MetadataNet {
  fetch: (request: HttpRequest) => Promise<HttpReply>
}

/** Who answered, and what they said. */
export interface Answer {
  provider: MetadataProvider
  matches: MetadataMatch[]
}

/**
 * Whatever each service needs to be reached.
 *
 * TMDB's key and token are kept in one field and read apart by
 * `readCredential`, which is why this hands the whole string over rather than
 * trying to tell them apart here.
 */
export function credentialFor(provider: MetadataProvider, settings: AppSettings): ServiceCredential {
  switch (provider.id) {
    case 'radarr':
      return { url: settings.radarrUrl.trim() || undefined, apiKey: settings.radarrApiKey.trim() || undefined }
    case 'sonarr':
      return { url: settings.sonarrUrl.trim() || undefined, apiKey: settings.sonarrApiKey.trim() || undefined }
    case 'tmdb':
      return { apiKey: settings.tmdbCredential.trim() || undefined }
    default:
      return {}
  }
}

/**
 * Which services are to be asked at all.
 *
 * A service is asked when it is switched on *and* it has what it needs. The
 * second half matters: a Radarr left switched on with its address cleared
 * would otherwise be asked and refuse, once per file, for nothing.
 */
export function askable(settings: AppSettings): string[] {
  return METADATA_PROVIDERS.filter((provider) => {
    if (!settings.metadataProviders.includes(provider.id)) return false
    const credential = credentialFor(provider, settings)
    if (provider.needs === 'url-and-api-key') return Boolean(credential.url && credential.apiKey)
    if (provider.needs === 'api-key') return Boolean(credential.apiKey)
    return true
  }).map((provider) => provider.id)
}

/** Whether anything at all could answer about this kind of thing. */
export function anythingAskable(settings: AppSettings, kind: MetadataQuery['kind']): boolean {
  return preferred(kind, askable(settings)).length > 0
}

/**
 * One run of lookups, sharing what it has already fetched.
 *
 * Held for as long as a dialog is open and thrown away with it. Only requests
 * with no body are remembered — everything here is a GET, and a request that
 * carried one would be an instruction rather than a question.
 */
/**
 * A refusal with the service's name on it, unless it says so already.
 *
 * Every provider's own messages name the service, because they are shown on
 * their own as well — so prefixing unconditionally gives "The Movie Database:
 * TMDB answered 503."
 */
function named(name: string, id: string, problem: string): string {
  const already = problem.toLowerCase()
  return already.includes(name.toLowerCase()) || already.includes(id.toLowerCase())
    ? problem
    : `${name}: ${problem}`
}

/** What was told to whom, for the one line a job's log gets. */
export interface Announced {
  service: RescanService
  /** The service's name, for saying so on screen. */
  name: string
  /** What the service calls the film or series it is going to look at again. */
  title: string
}

export interface MetadataSession {
  lookUp: (query: MetadataQuery) => Promise<Answer | ProviderProblem>
  fillIn: (match: MetadataMatch) => Promise<MetadataMatch | ProviderProblem>
  /** See `tellTheLibrary` on the returned object. */
  tellTheLibrary: (
    kind: MetadataQuery['kind'],
    filePath: string
  ) => Promise<Announced | ProviderProblem | undefined>
  forget: () => void
}

export function metadataSession(net: MetadataNet, settings: AppSettings): MetadataSession {
  const inFlight = new Map<string, Promise<HttpReply>>()

  const fetch = (request: HttpRequest): Promise<HttpReply> => {
    if (request.body !== undefined || (request.method ?? 'GET') !== 'GET') return net.fetch(request)
    const key = request.url
    const known = inFlight.get(key)
    if (known) return known
    const started = net.fetch(request)
    inFlight.set(key, started)
    return started
  }

  async function ask(provider: MetadataProvider, query: MetadataQuery): Promise<Answer | ProviderProblem> {
    const credential = credentialFor(provider, settings)
    const request = provider.search(query, credential)
    if (isProblem(request)) return request
    const matches = provider.readSearch(await fetch(request), query)
    if (isProblem(matches)) return matches
    return { provider, matches }
  }

  async function lookUp(query: MetadataQuery): Promise<Answer | ProviderProblem> {
    const asking = preferred(query.kind, askable(settings))
    if (asking.length === 0) {
      return {
        problem: 'Nothing is set up to look this up.',
        hint: 'Paste a themoviedb.org key under Metadata, or switch on Radarr or Sonarr under Services.',
        needsLogin: true
      }
    }

    const refusals: string[] = []
    for (const provider of asking) {
      const answer = await ask(provider, query)
      if (isProblem(answer)) {
        refusals.push(named(provider.name, provider.id, answer.problem))
        continue
      }
      if (answer.matches.length > 0) return answer
      refusals.push(`${provider.name} found nothing.`)
    }

    /*
     * Every refusal, not the last one. "Radarr has no film at that path" on
     * its own reads as a failure of Radarr; followed by "themoviedb.org found
     * nothing" it is the whole story, and the second line is the one that says
     * the title guessed out of the file name was wrong.
     */
    return {
      problem: refusals.join(' '),
      // Only worth offering when every service that could have answered said
      // it was not set up properly, rather than that it had not heard of this.
      needsLogin: false
    }
  }

  /**
   * Everything the search did not say: an episode's own title, a film's
   * genres.
   *
   * A provider without a `details` call has already said everything it knows,
   * which is an answer and not a gap — so the match comes back unchanged
   * rather than as a failure.
   */
  async function fillIn(match: MetadataMatch): Promise<MetadataMatch | ProviderProblem> {
    const provider = METADATA_PROVIDERS.find((candidate) => candidate.id === match.provider)
    if (!provider) return { problem: `${match.provider} is not a service this version knows about.` }
    if (!provider.details || !provider.readDetails) return match

    const request = provider.details(match, credentialFor(provider, settings))
    if (isProblem(request)) return request
    return provider.readDetails(await fetch(request), match)
  }

  /**
   * Tell the library manager that the file it owns has been replaced.
   *
   * The integration that matters most and is least visible. PlexFixer repairs
   * `Dune (2021).mkv` into `Dune (2021).mp4` and moves the original into the
   * backup folder. Radarr's database still says the film is the `.mkv`: it
   * reports the film as missing, and on its next search it downloads a
   * replacement for a film sitting right where it left it.
   *
   * It is asked with the *source* path, not the repaired one, and that is the
   * point: Radarr's record still points at the old file, so matching on the
   * path it knows is what finds the film at all. After the rescan it will know
   * about the new one.
   *
   * Only a provider that matched the file itself is told, because only that
   * one has an id that means this film. A database match is a guess at a name
   * and a rescan is a write; a guess is not grounds for one.
   *
   * `undefined` means there was nothing to tell — no library manager is set up
   * for this kind of file, or none of them has heard of it. That is the usual
   * case for somebody who runs neither, and is not a failure.
   */
  async function tellTheLibrary(
    kind: MetadataQuery['kind'],
    filePath: string
  ): Promise<Announced | ProviderProblem | undefined> {
    for (const provider of preferred(kind, askable(settings))) {
      // The two that have a rescan command, which is also the two that know
      // where a file is. A database has neither.
      if (provider.id !== 'radarr' && provider.id !== 'sonarr') continue

      const answer = await ask(provider, { kind, filePath })
      if (isProblem(answer)) continue

      /*
       * Only the match made against the file itself. Both of these already
       * answer with just that one when they are asked by path — this is the
       * line that keeps the rule true if either of them ever stops.
       */
      const match = answer.matches.find((one) => one.pathMatch)
      const id = Number(match?.id)
      if (!match || !Number.isInteger(id)) continue

      const credential = credentialFor(provider, settings)
      const request = rescanRequest(provider.id, credential, id)
      if (isProblem(request)) return request

      const started = readRescan(await net.fetch(request), provider.id)
      if (isProblem(started)) return started
      return { service: provider.id, name: provider.name, title: match.title }
    }

    return undefined
  }

  return { lookUp, fillIn, tellTheLibrary, forget: () => inFlight.clear() }
}
