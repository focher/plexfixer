/**
 * What a subtitle service has to be able to do, and nothing about how.
 *
 * The request/reply boundary every provider is written against lives in
 * `../../providers/http.js`, shared with the metadata providers; what is here
 * is only what is particular to subtitles. It is re-exported, so a provider
 * still has one import.
 */

export * from '../../providers/http.js'
import type { HttpReply, HttpRequest, ProviderCredential, ProviderProblem } from '../../providers/http.js'

/**
 * What is known about the film, as far as finding subtitles for it goes.
 *
 * Everything is optional because every service matches on a different subset,
 * and because the app genuinely may not know: a file named `movie.mkv` with no
 * metadata has nothing but its hash, and the hash is the best of these anyway.
 */
export interface SubtitleQuery {
  /** The file's own hash, which identifies this exact encode. */
  movieHash?: string
  sizeBytes?: number
  /** The film or series title, as the naming rules worked it out. */
  title?: string
  year?: number
  season?: number
  episode?: number
  /** ISO 639-2/B codes, in the order they are wanted. */
  languages: string[]
  /** The file's own name, which several services match against release names. */
  fileName?: string
  imdbId?: string
  tmdbId?: number
}

/** One subtitle a service is offering. */
export interface SubtitleCandidate {
  /** Which provider found it; the id below means nothing to any other. */
  provider: string
  id: string
  /** ISO 639-2/B. */
  language: string
  /** The release the uploader says it was timed against. */
  release?: string
  fileName?: string
  /**
   * The service matched this against the file's hash, not against its name.
   *
   * The single most useful fact about a candidate. A hash match means somebody
   * uploaded a subtitle for this exact encode, and its timing is usually right
   * to the frame; a title match means somebody uploaded a subtitle for a film
   * of this name, and the timing is anybody's guess.
   */
  hashMatch: boolean
  hearingImpaired?: boolean
  forced?: boolean
  /**
   * The service says this was produced by a machine rather than a person.
   *
   * Worth knowing and worth showing: this app can produce one of those itself,
   * so there is little reason to download someone else's.
   */
  machineTranslated?: boolean
  downloads?: number
  /** Out of ten, as the services score them. */
  rating?: number
  uploader?: string
  /** Set when the service says how many parts the subtitle is in; more than one is rare and awkward. */
  parts?: number
}

/**
 * A subtitle service.
 *
 * Downloading is two steps for some services and one for others — ask for a
 * link, then fetch it — so `readDownload` may answer with either the subtitle
 * or another address to try. The service layer follows at most one.
 */
export interface SubtitleProvider {
  /** Stable id, stored in settings; never renamed once shipped. */
  readonly id: string
  readonly name: string
  /** Where to go to get a credential, shown beside the field. */
  readonly site: string
  /** What it needs before it will answer at all. */
  readonly needs: 'nothing' | 'api-key' | 'api-key-and-login'
  /** One line under the switch in Settings. */
  readonly summary: string

  /** The sign-in request, for a service that has one. */
  login?(credential: ProviderCredential): HttpRequest | ProviderProblem
  readLogin?(reply: HttpReply): { token: string } | ProviderProblem

  /**
   * The search request, or a refusal when this service cannot answer this
   * question at all — a series-only service asked about a film, say.
   */
  search(query: SubtitleQuery, credential: ProviderCredential): HttpRequest | ProviderProblem
  readSearch(reply: HttpReply, query: SubtitleQuery): SubtitleCandidate[] | ProviderProblem

  download(candidate: SubtitleCandidate, credential: ProviderCredential): HttpRequest | ProviderProblem
  readDownload(reply: HttpReply): { follow: HttpRequest } | { bytes: Uint8Array } | ProviderProblem
}
