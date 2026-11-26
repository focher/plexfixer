/**
 * The shape every outside service is talked to through.
 *
 * A provider here is pure: it is handed a question and returns the request that
 * would ask it, and it is handed a reply and returns what that reply said. It
 * never performs the request. That is deliberate — the page is allowed to talk
 * to this app and to nothing else, so every request leaves from Rust, against
 * an address either written into the binary or named in Settings. A provider
 * that could fetch for itself would have to be trusted with that door; a
 * provider that only describes requests cannot be pointed anywhere its own
 * module does not already name.
 *
 * It also means a provider is testable against a saved reply, which is the
 * only honest way to test one: a service’s wire format is not something to
 * find out from production.
 *
 * This file holds what subtitle services and metadata services have in common.
 * Neither kind knows about the other; both describe requests the same way,
 * and a reader of replies that is careful about rubbish is worth writing once.
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

/** Whatever a service needs to be talked to. */
export interface ProviderCredential {
  /**
   * The service's own address, for one that is not at a fixed one.
   *
   * A database lives at an address written into this app. A library manager —
   * Radarr, Sonarr, Bazarr — lives wherever the person running it put it, so
   * its address is part of what it takes to talk to it at all.
   */
  url?: string
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
