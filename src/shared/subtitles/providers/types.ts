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
  /**
   * Where the file is.
   *
   * Meaningless to a database on the other side of the world, and the only
   * thing a library manager on this network identifies a file by: Bazarr knows
   * which film this is because Radarr told it where it put the file.
   */
  filePath?: string
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
 * How a service hands over the subtitle it found.
 *
 * `bytes` is the shape everything was first written for: ask for a subtitle,
 * receive a subtitle. `to-the-folder` is the shape a library manager has —
 * Bazarr does not hand anything back, it fetches the file itself and writes it
 * beside the film, and answers the request with nothing at all. Nothing came
 * back to read, so the file has to be found on disk afterwards, which is what
 * `collect` is for.
 *
 * It is stated on the provider rather than inferred from the reply because the
 * difference decides what the service layer has to be holding before it starts:
 * a `to-the-folder` download is useless without the path of the film it is
 * being fetched for.
 */
export type SubtitleDelivery = 'bytes' | 'to-the-folder'

/**
 * One more request before a search can be answered, and a name for where it
 * leaves off.
 *
 * Some services answer "find subtitles for this file" in one request and some
 * take three: Bazarr has to be asked which of its series this file belongs to,
 * then which episode, and only then for subtitles. `step` is whatever the
 * provider wants to call that place in its own chain, handed straight back on
 * the next `readSearch`. Nothing but the provider ever reads it, so a provider
 * is free to carry an id it learned along the way inside it — which is exactly
 * what Bazarr does, because the download needs the ids the chain discovered.
 */
export interface SubtitleStep {
  follow: HttpRequest
  step: string
}

export function isStep<T>(value: T | SubtitleStep): value is SubtitleStep {
  return typeof value === 'object' && value !== null && 'follow' in value && 'step' in value
}

/** One subtitle file a service says it has beside the film. */
export interface SavedSubtitle {
  /** The service's own path for it, which may not be this machine's. */
  path: string
  sizeBytes?: number
}

/**
 * What a service has beside the film, in the language that was asked for.
 *
 * An empty list is an ordinary answer and not a failure: Bazarr's download
 * endpoint puts the job on a queue and answers immediately, so the first look
 * is usually too early.
 *
 * The whole list comes back rather than one best guess because the caller is
 * not asking "is there a subtitle" — a film may well have had one in this
 * language already — but "is there one that was not here a moment ago". Only
 * the caller, holding the list from before the download, can answer that.
 */
export type Collected = { saved: SavedSubtitle[] }

/**
 * A subtitle service.
 *
 * Downloading is two steps for some services and one for others — ask for a
 * link, then fetch it — so `readDownload` may answer with either the subtitle
 * or another address to try. The service layer follows at most one. A service
 * that delivers `to-the-folder` answers with neither, and is asked `collect`
 * instead.
 */
export interface SubtitleProvider {
  /** Stable id, stored in settings; never renamed once shipped. */
  readonly id: string
  readonly name: string
  /** Where to go to get a credential, shown beside the field. */
  readonly site: string
  /** What it needs before it will answer at all. */
  readonly needs: 'nothing' | 'api-key' | 'api-key-and-login' | 'url-and-api-key'
  /** How it hands the subtitle over; see `SubtitleDelivery`. */
  readonly delivers: SubtitleDelivery
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
  /**
   * `step` is whatever this provider returned alongside its last `follow`, and
   * is undefined for the reply to `search` itself. The credential comes back
   * too, because a provider that answers with another request needs the same
   * address and key it needed to build the first one, and a reply does not
   * carry where it came from.
   */
  readSearch(
    reply: HttpReply,
    query: SubtitleQuery,
    step?: string,
    credential?: ProviderCredential
  ): SubtitleCandidate[] | SubtitleStep | ProviderProblem

  download(candidate: SubtitleCandidate, credential: ProviderCredential): HttpRequest | ProviderProblem
  readDownload(
    reply: HttpReply
  ): { follow: HttpRequest } | { bytes: Uint8Array } | { inTheFolder: true } | ProviderProblem

  /**
   * Ask where the subtitle ended up, for a service that delivers to the folder.
   *
   * Required of such a service and meaningless to any other. The path that
   * comes back is the service's own — a container's `/movies/...` where this
   * machine says `/Volumes/media/Films/...` — so the caller matches it to the
   * film it already holds rather than opening it blind.
   */
  collect?(candidate: SubtitleCandidate, credential: ProviderCredential): HttpRequest | ProviderProblem
  readCollect?(reply: HttpReply, candidate: SubtitleCandidate): Collected | ProviderProblem
}
