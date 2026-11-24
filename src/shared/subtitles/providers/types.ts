/**
 * What a subtitle service has to be able to do, and nothing about how.
 *
 * A provider here is pure: it is handed a question and returns the request that
 * would ask it, and it is handed a reply and returns what that reply said. It
 * never performs the request. That is deliberate and it is the same boundary
 * `tmdb.ts` sits behind — the page is allowed to talk to this app and to
 * nothing else, so every request leaves from Rust, against a host written into
 * the binary. A provider that could fetch for itself would have to be trusted
 * with that door; a provider that only describes requests cannot be pointed
 * anywhere its own module does not already name.
 *
 * It also means a provider is testable against a saved reply, which is the only
 * honest way to test one: a service's wire format is not something to find out
 * from production.
 */

/** One request, for the transport on the native side to make. */
export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Already serialised; a provider decides its own content type. */
  body?: string
  /**
   * Fetch the reply as bytes rather than as text.
   *
   * Subtitle files are routinely not UTF-8 — see `decodeSubtitleBytes` — so the
   * one request that fetches the subtitle itself has to come back undecoded.
   */
  binary?: boolean
}

/** What a reply looked like. */
export interface HttpReply {
  status: number
  /** The body as text, for everything but the subtitle download itself. */
  text?: string
  bytes?: Uint8Array
}

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

/** Whatever a service needs to be talked to. */
export interface ProviderCredential {
  apiKey?: string
  username?: string
  password?: string
  /** Held from a previous login by the service layer, not stored in settings. */
  token?: string
}

/** A reply that could not be read, with something a person can act on. */
export interface ProviderProblem {
  problem: string
  /** What to do about it, when there is something. */
  hint?: string
  /** True when signing in, or signing in again, would fix it. */
  needsLogin?: boolean
}

export function isProblem<T>(value: T | ProviderProblem): value is ProviderProblem {
  return typeof value === 'object' && value !== null && 'problem' in value
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

/* ------------------------------------------------------------------ *
 * Reading a reply nothing here wrote
 * ------------------------------------------------------------------ */

/**
 * JSON from a service is not a type, whatever the documentation says.
 *
 * These are the only way anything in a reply is read. A field that is missing,
 * null, or the wrong kind entirely answers undefined rather than throwing, so
 * one unexpected field does not lose the ninety-nine good results beside it.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function asFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (lower === 'true' || lower === '1' || lower === 'yes') return true
    if (lower === 'false' || lower === '0' || lower === 'no') return false
  }
  return undefined
}

/** Parse a JSON body, saying so rather than throwing when it is not JSON. */
export function readJson(reply: HttpReply, service: string): unknown | ProviderProblem {
  const body = reply.text ?? ''
  if (body.trim() === '') return { problem: `${service} sent an empty reply.` }
  try {
    return JSON.parse(body) as unknown
  } catch {
    // An HTML error page is the usual cause, and quoting a kilobyte of it at
    // somebody helps nobody.
    return { problem: `${service} sent something that is not JSON (${reply.status}).` }
  }
}
