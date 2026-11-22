/**
 * Looking a film up on The Movie Database.
 *
 * All of it except the request itself: building the addresses, reading what
 * comes back, and guessing what to search for from a file name. The request is
 * made in Rust, because the page is allowed to talk to this app and nothing
 * else — so everything here is pure, and everything here is tested.
 *
 * The key belongs to whoever is running the app. TMDB gives one away for the
 * asking and asks that it not be shared, which rules out shipping one in a
 * binary that anybody can open.
 */

/** What a search turned up, or what a details call filled in. */
export interface TmdbMatch {
  id: number
  kind: TmdbKind
  title: string
  /** Four digits, when the database knows. */
  year?: string
  /** The full release date, from a details call. */
  date?: string
  overview: string
  genres?: string[]
}

export type TmdbKind = 'movie' | 'tv'

const BASE = 'https://api.themoviedb.org/3/'

/* ------------------------------------------------------------------ *
 * Which of the two things TMDB gives you
 * ------------------------------------------------------------------ */

/**
 * TMDB hands out two credentials and does not make it obvious that either
 * will do.
 *
 * The **API Key** is 32 hex characters and goes in the query string. The
 * **API Read Access Token** is a JWT and goes in an Authorization header.
 * Both work against the same endpoints, so rather than asking somebody to
 * know which one they copied, the shape is read off it.
 */
export type TmdbCredential = { kind: 'key'; value: string } | { kind: 'token'; value: string }

/** A JWT: three dot-separated parts, and the first always begins `ey`. */
const JWT = /^ey[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/**
 * Nothing, or whichever of the two was pasted in.
 *
 * Anything that is not plainly a token is treated as a key, which is the
 * forgiving way round: a key is what most people have, and a wrong guess
 * produces TMDB's own "invalid API key" rather than silence.
 */
export function readCredential(raw: string): TmdbCredential | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  return JWT.test(value) ? { kind: 'token', value } : { kind: 'key', value }
}

/** What to send in the Authorization header, for the credential that needs one. */
export function authHeader(credential: TmdbCredential): string | undefined {
  return credential.kind === 'token' ? `Bearer ${credential.value}` : undefined
}

/** TMDB calls a film's name `title` and a series' name `name`. */
const NAME_KEY: Record<TmdbKind, string> = { movie: 'title', tv: 'name' }
const DATE_KEY: Record<TmdbKind, string> = { movie: 'release_date', tv: 'first_air_date' }

function url(path: string, credential: TmdbCredential, params: Record<string, string>): string {
  // A token travels in a header instead, so it never goes near the query
  // string — nothing that logs a URL gets to keep it.
  const query = new URLSearchParams(credential.kind === 'key' ? { api_key: credential.value, ...params } : params)
  const tail = query.toString()
  return tail === '' ? `${BASE}${path}` : `${BASE}${path}?${tail}`
}

export function searchUrl(credential: TmdbCredential, kind: TmdbKind, query: string, year?: string): string {
  const params: Record<string, string> = { query, include_adult: 'false' }
  // The year narrows a search hard, so it is only sent when it looks like one:
  // a wrong year finds nothing at all, which reads as "no such film".
  if (year && /^\d{4}$/.test(year)) params[kind === 'movie' ? 'year' : 'first_air_date_year'] = year
  return url(`search/${kind}`, credential, params)
}

export function detailsUrl(credential: TmdbCredential, kind: TmdbKind, id: number): string {
  return url(`${kind}/${id}`, credential, {})
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function yearOf(date: string): string | undefined {
  const match = /^(\d{4})/.exec(date)
  return match?.[1]
}

function matchFrom(entry: Record<string, unknown>, kind: TmdbKind): TmdbMatch | undefined {
  const id = entry.id
  if (typeof id !== 'number') return undefined
  const title = asString(entry[NAME_KEY[kind]])
  if (title === '') return undefined
  const date = asString(entry[DATE_KEY[kind]])
  return {
    id,
    kind,
    title,
    date: date === '' ? undefined : date,
    year: yearOf(date),
    overview: asString(entry.overview)
  }
}

/**
 * The results, best first.
 *
 * TMDB already orders them by its own popularity score, which is a better
 * guess than anything that could be worked out here, so the order is kept.
 * Anything without an id or a name is dropped rather than shown as a blank
 * row somebody might pick.
 */
export function parseSearch(body: string, kind: TmdbKind): TmdbMatch[] {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null) return []
  const results = (parsed as { results?: unknown }).results
  if (!Array.isArray(results)) return []

  const matches: TmdbMatch[] = []
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) continue
    const match = matchFrom(entry as Record<string, unknown>, kind)
    if (match) matches.push(match)
  }
  return matches
}

/** One title in full, which is where the genres are. */
export function parseDetails(body: string, kind: TmdbKind): TmdbMatch | undefined {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const entry = parsed as Record<string, unknown>
  const match = matchFrom(entry, kind)
  if (!match) return undefined

  const genres = Array.isArray(entry.genres)
    ? entry.genres
        .map((genre) => (typeof genre === 'object' && genre !== null ? asString((genre as { name?: unknown }).name) : ''))
        .filter((name) => name !== '')
    : []

  return { ...match, genres: genres.length > 0 ? genres : undefined }
}

/** What a match would write into the file. */
export function tagsFromMatch(match: TmdbMatch): Record<string, string> {
  const tags: Record<string, string> = { title: match.title }
  // The full date where there is one — a player that wants only the year will
  // take the first four characters, and one that wants the date has it.
  if (match.date) tags.date = match.date
  else if (match.year) tags.date = match.year
  if (match.overview) tags.description = match.overview
  if (match.genres?.length) tags.genre = match.genres.join(', ')
  return tags
}

/* ------------------------------------------------------------------ *
 * Guessing what to search for
 * ------------------------------------------------------------------ */

/**
 * The noise a release leaves in a file name.
 *
 * Everything from the first of these onwards is dropped: they only ever
 * appear after the title, and whatever follows one is more of the same.
 */
const NOISE =
  /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?|hdr|dv|sdr|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|web|hdtv|dvdrip|dvd|remux|proper|repack|extended|unrated|directors?\.?cut|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|aac|ac3|eac3|dts(-hd)?|truehd|atmos|ddp?5\.1|5\.1|7\.1|10bit|8bit)\b/i

/**
 * A year in brackets, which is the convention Plex asks for and the only
 * unambiguous form: `Blade Runner 2049 (2017)` has two numbers that look like
 * years and only one of them is one.
 *
 * A full release date counts: some libraries write `(2017-05-05)`, and the
 * year is still the only part of it worth searching on.
 */
const BRACKETED_YEAR = /[([](19\d{2}|20\d{2})(?:[-./]\d{1,2}){0,2}[)\]]/

/** A year standing on its own, for names written without the brackets. */
const BARE_YEAR = /\b(19\d{2}|20\d{2})\b/g

/**
 * Whether a piece of text still has a release's details in it.
 *
 * The same vocabulary the file name is stripped with, offered because a title
 * tag reading `Heat.1080p.BluRay.x264` is a ripper's placeholder rather than a
 * title, and is worth noticing wherever it turns up.
 */
export function looksLikeARelease(text: string): boolean {
  return NOISE.test(text)
}

export interface GuessedTitle {
  title: string
  year?: string
}

/**
 * Drop a bracket that never closes, and everything after it.
 *
 * Cutting the year out of the middle of a name leaves whatever opened the
 * bracket it was sitting in: `Blade Runner (05-05-2017)` cut at the year
 * leaves `Blade Runner (05-05-`. A half-open bracket is never part of a
 * title, so everything from it onwards goes. A bracket that does close is
 * left alone — `Fanny and Alexander (TV Cut)` means it.
 */
function dropUnclosedBracket(name: string): string {
  const open = Math.max(name.lastIndexOf('('), name.lastIndexOf('['))
  if (open === -1) return name
  const close = Math.max(name.lastIndexOf(')'), name.lastIndexOf(']'))
  return close > open ? name : name.slice(0, open)
}

/**
 * A search term from a file name.
 *
 * File names are the one thing a media library always has, and they are
 * written to a convention that is nearly universal and never quite followed:
 * the title, the year, and then a long tail of how it was encoded. Taking the
 * title and the year off the front is right far more often than it is wrong,
 * and the search box is editable for the rest.
 */
export function guessTitle(fileName: string): GuessedTitle {
  // The extension, and anything a scene release put in brackets at the end.
  let name = fileName.replace(/\.[a-z0-9]{2,4}$/i, '')

  // A bracketed year wins outright. Failing that, the *last* year-like number
  // is the release year and anything before it is the title — which is the
  // only reading that leaves `Blade Runner 2049` with its name. A title that
  // is itself a year, and carries no release year, cannot be told apart from
  // a release year by anything short of asking; the search box is editable.
  let year: string | undefined
  const bracketed = BRACKETED_YEAR.exec(name)
  if (bracketed) {
    year = bracketed[1]
    name = name.slice(0, bracketed.index)
  } else {
    let last: RegExpMatchArray | undefined
    for (const found of name.matchAll(BARE_YEAR)) last = found
    if (last?.index !== undefined) {
      year = last[1]
      name = name.slice(0, last.index)
    }
  }

  const noise = NOISE.exec(name)
  if (noise) name = name.slice(0, noise.index)

  // Separators, then the punctuation a title is left wearing.
  name = dropUnclosedBracket(name)
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–—]+$/, '')
    .trim()

  return { title: name, year }
}
