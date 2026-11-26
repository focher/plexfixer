/**
 * OpenSubtitles, through the REST API at api.opensubtitles.com.
 *
 * The one with the coverage, and the one worth getting right. Two things about
 * it shape everything here:
 *
 * **It wants a key of your own.** Like TMDB, OpenSubtitles hands out an API key
 * for the asking and asks that it not be passed around, which rules out one
 * shipped inside a binary anybody can open. So the field is empty until
 * somebody pastes theirs in, and search says so until then.
 *
 * **Downloading is a separate, counted act.** Search is free; a download spends
 * one of a daily allowance tied to the account, so it is two steps — ask for a
 * link, then fetch it — and the reply to the first step says how many are
 * left. That number is worth surfacing rather than swallowing: "you have five
 * downloads left today" is the difference between a person understanding a
 * failure and filing a bug about it.
 */

import { languageAlpha2, normalizeLanguage } from '../../languages.js'
import {
  asArray,
  asFlag,
  asNumber,
  asRecord,
  asText,
  isProblem,
  readJson,
  type HttpReply,
  type HttpRequest,
  type ProviderCredential,
  type SubtitleCandidate,
  type SubtitleProvider
} from './types.js'

export const OPENSUBTITLES_ID = 'opensubtitles'

/** The only address this provider ever produces. Rust checks it again. */
const BASE = 'https://api.opensubtitles.com/api/v1/'

/**
 * The service asks every client to identify itself, and refuses the ones that
 * do not. Rust sends this; it carries the app's name and nothing about the
 * person using it.
 */
export const OPENSUBTITLES_USER_AGENT = 'PlexFixer'

/**
 * Where the service splits a language this app treats as one.
 *
 * Brazilian and European Portuguese are separate catalogues there and one
 * language here, and asking for `pt` alone returns neither. So a request for
 * Portuguese asks for both and takes whichever turns up — which is the honest
 * answer to "I want Portuguese subtitles" from somebody who did not say which.
 */
const SPLIT_LANGUAGES: Record<string, string[]> = {
  por: ['pt-pt', 'pt-br'],
  chi: ['zh-cn', 'zh-tw']
}

/** ISO 639-2/B in, whatever the service calls it out. */
export function serviceLanguages(languages: readonly string[]): string[] {
  const out: string[] = []
  for (const language of languages) {
    const bib = normalizeLanguage(language)
    const split = SPLIT_LANGUAGES[bib]
    if (split) {
      out.push(...split)
      continue
    }
    const alpha2 = languageAlpha2(bib)
    if (alpha2) out.push(alpha2)
  }
  // The service wants them sorted and without repeats, and answers 400 when
  // they are not.
  return [...new Set(out)].sort()
}

/** Whatever the service called it, back to ISO 639-2/B. */
function ourLanguage(value: unknown): string {
  return normalizeLanguage(asText(value) ?? 'und')
}

/* ------------------------------------------------------------------ *
 * Building the requests
 * ------------------------------------------------------------------ */

function headers(credential: ProviderCredential, json = false): Record<string, string> {
  const result: Record<string, string> = {
    'Api-Key': credential.apiKey ?? '',
    Accept: 'application/json'
  }
  if (json) result['Content-Type'] = 'application/json'
  // A token is only ever present after a successful login, and only downloads
  // need one.
  if (credential.token) result.Authorization = `Bearer ${credential.token}`
  return result
}

/**
 * A query string built from only the parameters that have a value.
 *
 * Empty parameters are not harmless here: the service answers 400 for several
 * of them rather than ignoring them.
 */
function query(parameters: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  // Sorted, because the service's own cache keys on the query string and its
  // documentation asks for it.
  search.sort()
  return search.toString()
}

export const openSubtitles: SubtitleProvider = {
  id: OPENSUBTITLES_ID,
  name: 'OpenSubtitles',
  site: 'https://www.opensubtitles.com/en/consumers',
  needs: 'api-key-and-login',
  delivers: 'bytes',
  summary:
    'The largest of them, and the only one here that matches on the file itself. Needs an API key, and a ' +
    'username and password to download: the key identifies the app, the account carries the daily allowance.',

  login(credential) {
    if (!credential.username || !credential.password) {
      return {
        problem: 'OpenSubtitles needs the username and password of your account before it will hand over a subtitle.',
        hint: 'Searching works with just the API key; downloading does not.',
        needsLogin: true
      }
    }
    return {
      url: `${BASE}login`,
      method: 'POST',
      headers: headers(credential, true),
      body: JSON.stringify({ username: credential.username, password: credential.password })
    }
  },

  readLogin(reply) {
    const parsed = readJson(reply, 'OpenSubtitles')
    if (isProblem(parsed)) return parsed
    const body = asRecord(parsed)
    const token = asText(body?.token)
    if (token) return { token }
    if (reply.status === 401) {
      return { problem: 'OpenSubtitles did not accept that username and password.', needsLogin: true }
    }
    return {
      problem: asText(body?.message) ?? `OpenSubtitles refused the sign-in (${reply.status}).`,
      needsLogin: true
    }
  },

  search(request, credential) {
    if (!credential.apiKey) {
      return {
        problem: 'OpenSubtitles needs an API key of your own.',
        hint: 'They give one away for the asking; paste it into Settings → Subtitles.'
      }
    }

    const languages = serviceLanguages(request.languages)
    if (languages.length === 0) {
      return { problem: 'None of the languages asked for has a code OpenSubtitles recognises.' }
    }

    const episode = request.season !== undefined && request.episode !== undefined

    return {
      url: `${BASE}subtitles?${query({
        languages: languages.join(','),
        // The hash is sent alongside the title rather than instead of it. The
        // service returns name matches as well as the hash match and flags
        // which is which, so one request answers both questions — and a hash
        // that nobody has ever uploaded for still gets a useful reply.
        moviehash: request.movieHash,
        query: request.movieHash ? undefined : request.title,
        imdb_id: request.imdbId?.replace(/^tt/, ''),
        tmdb_id: request.tmdbId,
        year: episode ? undefined : request.year,
        season_number: request.season,
        episode_number: request.episode,
        type: episode ? 'episode' : 'movie'
      })}`,
      headers: headers(credential)
    }
  },

  readSearch(reply, request) {
    const parsed = readJson(reply, 'OpenSubtitles')
    if (isProblem(parsed)) return parsed
    const body = asRecord(parsed)

    if (reply.status === 401 || reply.status === 403) {
      return {
        problem: asText(body?.message) ?? 'OpenSubtitles did not accept that API key.',
        hint: 'Check the key in Settings → Subtitles against the one on your account.'
      }
    }
    if (reply.status === 429) {
      return { problem: 'OpenSubtitles is asking for fewer requests. Give it a minute and try again.' }
    }
    if (reply.status >= 400) {
      return { problem: asText(body?.message) ?? `OpenSubtitles returned ${reply.status}.` }
    }

    const wanted = new Set(request.languages.map((language) => normalizeLanguage(language)))
    const candidates: SubtitleCandidate[] = []

    for (const entry of asArray(body?.data)) {
      const row = asRecord(entry)
      const attributes = asRecord(row?.attributes)
      if (!attributes) continue

      // The file id is what a download asks for, not the subtitle id — and a
      // subtitle in two parts has two of them. Only the first part can be
      // fetched this way, so the count is carried and the UI says so.
      const files = asArray(attributes.files)
      const first = asRecord(files[0])
      const fileId = asNumber(first?.file_id)
      if (fileId === undefined) continue

      const language = ourLanguage(attributes.language)
      // The service occasionally returns a language nobody asked for. Dropping
      // it here rather than showing it keeps the list honest about what was
      // requested.
      if (wanted.size > 0 && !wanted.has(language)) continue

      candidates.push({
        provider: OPENSUBTITLES_ID,
        id: String(fileId),
        language,
        release: asText(attributes.release),
        fileName: asText(first?.file_name),
        hashMatch: asFlag(attributes.moviehash_match) ?? false,
        hearingImpaired: asFlag(attributes.hearing_impaired),
        forced: asFlag(attributes.foreign_parts_only),
        machineTranslated: (asFlag(attributes.machine_translated) ?? false) || (asFlag(attributes.ai_translated) ?? false),
        downloads: asNumber(attributes.download_count),
        rating: asNumber(attributes.ratings),
        uploader: asText(asRecord(attributes.uploader)?.name),
        parts: files.length > 1 ? files.length : undefined
      })
    }

    return candidates
  },

  download(candidate, credential) {
    if (!credential.apiKey) return { problem: 'OpenSubtitles needs an API key of your own.' }
    if (!credential.token) {
      return {
        problem: 'OpenSubtitles needs you signed in before it will hand over a subtitle.',
        needsLogin: true
      }
    }
    return {
      url: `${BASE}download`,
      method: 'POST',
      headers: headers(credential, true),
      body: JSON.stringify({ file_id: Number(candidate.id) })
    }
  },

  readDownload(reply) {
    const parsed = readJson(reply, 'OpenSubtitles')
    if (isProblem(parsed)) return parsed
    const body = asRecord(parsed)

    if (reply.status === 406) {
      const resets = asText(body?.reset_time)
      return {
        problem: 'That account has used up its downloads for today.',
        hint: resets ? `The allowance comes back in ${resets}.` : 'The allowance comes back on the hour it was used.'
      }
    }
    if (reply.status === 401) {
      return { problem: 'OpenSubtitles wants you to sign in again.', needsLogin: true }
    }

    const link = asText(body?.link)
    if (!link) {
      return { problem: asText(body?.message) ?? `OpenSubtitles returned ${reply.status} with no download link.` }
    }
    // The link is to the service's own download host, which is not the API
    // host; the transport checks it against its own list, so a link to
    // anywhere else simply will not be fetched.
    return { follow: { url: link, binary: true } }
  }
}

/**
 * How many downloads the account has left, read out of a download reply.
 *
 * Worth pulling out separately: it arrives on a *successful* reply as well as
 * a refused one, so showing it costs nothing and tells somebody they are on
 * their last two before they find out by being refused.
 */
export function remainingDownloads(reply: HttpReply): { used?: number; remaining?: number } {
  try {
    const body = asRecord(JSON.parse(reply.text ?? ''))
    return { used: asNumber(body?.requests), remaining: asNumber(body?.remaining) }
  } catch {
    return {}
  }
}

/** Only used by the tests, to prove the request builder is not reachable elsewhere. */
export const OPENSUBTITLES_BASE = BASE

export type { HttpRequest }
