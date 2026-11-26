/**
 * Bazarr, as a provider — and the reason the interface beside this one grew.
 *
 * Bazarr is to subtitles what Radarr is to films: not a place subtitles come
 * from, but the thing that already has an account at every place they come
 * from, with your providers, your languages and your scoring rules set up
 * once. Asking it is asking all of them at once, under the settings you
 * already decided on.
 *
 * It does not, however, behave like a subtitle service, and pretending it does
 * would have been the dishonest way to write this file. Three differences, all
 * of which the interface now has words for:
 *
 * **It identifies a file by where it is.** There is no "find subtitles for
 * this hash". Bazarr knows this film because Radarr told it where the file
 * went, so the chain starts by asking Bazarr for its library and matching the
 * path — the same match `metadata/providers/radarr.ts` makes, for the same
 * reason. For an episode that is two steps: the series, then the episode.
 *
 * **It does not hand the subtitle back.** `POST providers/movies` answers
 * `204` with an empty body. What it actually does is put a job on a queue —
 * `movie_manually_download_specific_subtitle` returns immediately after
 * `jobs_queue.add_job_from_function` — and some seconds later the subtitle is
 * written into the film's own folder. So the reply says nothing about whether
 * it worked, and the file has to be found afterwards. That is what `delivers:
 * 'to-the-folder'` and `collect` exist for.
 *
 * **Its ids are cache keys.** `subtitle` in a search result is
 * `subtitle_cache.store(s)`, which expires. A candidate from a search an hour
 * old will not download; it has to be searched for again.
 *
 * Written against Bazarr's own source — `bazarr/api/providers/providers_movies.py`
 * and `providers_episodes.py` for the endpoints and their arguments,
 * `subtitles/manual.py` for the shape of a result, `api/swaggerui.py` for the
 * subtitle records a film carries — rather than against a guess. Bazarr
 * publishes a Swagger page at `/api/swaggerui` on any running instance, which
 * is the same information from the machine itself.
 */

import type {
  ProviderCredential,
  SavedSubtitle,
  SubtitleCandidate,
  SubtitleProvider,
  SubtitleQuery
} from './types.js'
import { asArray, asFlag, asNumber, asRecord, asText, isProblem, readJson } from './types.js'

export const BAZARR_ID = 'bazarr'

/** Trim a typed address to something requests can be built on. */
export function bazarrBase(url: string | undefined): string | undefined {
  const trimmed = (url ?? '').trim()
  if (trimmed === '') return undefined
  // Everything after a `#` is never sent, so an address copied out of Bazarr's
  // own URL bar — which is a hash route — would otherwise request the root.
  const withoutFragment = trimmed.split('#')[0].replace(/\/+$/, '')
  return withoutFragment === '' ? undefined : withoutFragment
}

/** Path comparison that survives the ways two systems spell the same file. */
function tidy(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * The last two segments of a path, which is what survives a different mount.
 *
 * Bazarr in a container calls it `/movies/Dune (2021)/Dune (2021).mkv`; this
 * machine calls it `/Volumes/media/Films/Dune (2021)/Dune (2021).mkv`. The
 * film's own folder and file name are the part the two agree on.
 */
export function tail(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = tidy(path).split('/').filter(Boolean)
  return parts.length === 0 ? undefined : parts.slice(-2).join('/')
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return tidy(a) === tidy(b) || (tail(a) !== undefined && tail(a) === tail(b))
}

/** Whether `file` is somewhere under `folder`, by the same relaxed comparison. */
function underFolder(folder: string | undefined, file: string | undefined): boolean {
  if (!folder || !file) return false
  const parts = tidy(folder).split('/').filter(Boolean)
  const name = parts[parts.length - 1]
  if (!name) return false
  // The series' own folder name appearing as a whole segment of the file's
  // path. A prefix test would put `Dark` inside `Dark Matter`.
  return tidy(file).split('/').includes(name)
}

/** An episode is anything that came with both numbers. */
function isEpisode(query: SubtitleQuery): boolean {
  return Number.isFinite(query.season) && Number.isFinite(query.episode)
}

function headers(credential: ProviderCredential): Record<string, string> {
  return { 'X-API-KEY': credential.apiKey ?? '', Accept: 'application/json' }
}

function ready(credential: ProviderCredential): { base: string } | { problem: string; hint?: string; needsLogin?: boolean } {
  const base = bazarrBase(credential.url)
  if (!base) {
    return { problem: 'No Bazarr address.', hint: 'Set one under Services in Settings.', needsLogin: true }
  }
  if (!credential.apiKey) {
    return { problem: 'No Bazarr API key.', hint: 'Settings → General → Security inside Bazarr.', needsLogin: true }
  }
  return { base }
}

/* ------------------------------------------------------------------ *
 * What a candidate has to remember
 * ------------------------------------------------------------------ */

/**
 * Everything the download needs, packed into the candidate's id.
 *
 * The ids are learned in the middle of the search chain — the film's Radarr id
 * comes from matching the library, three requests before the subtitle is
 * chosen — and `download` is handed nothing but the candidate. The interface
 * says a candidate's id means nothing to any other provider, so this is the
 * place for them.
 */
interface Handle {
  kind: 'movie' | 'episode'
  /** Radarr's id, for a film; Sonarr's series id, for an episode. */
  id: number
  /** Sonarr's episode id. Only for an episode. */
  episodeId?: number
  /** Which underlying service Bazarr found it at — `opensubtitles`, say. */
  from: string
  /** Bazarr's cache key for this particular subtitle. */
  subtitle: string
  hi: boolean
  forced: boolean
  originalFormat: boolean
}

function pack(handle: Handle): string {
  return JSON.stringify(handle)
}

function unpack(id: string): Handle | undefined {
  try {
    const parsed = JSON.parse(id) as Partial<Handle>
    if (typeof parsed?.subtitle !== 'string' || typeof parsed.id !== 'number') return undefined
    if (parsed.kind !== 'movie' && parsed.kind !== 'episode') return undefined
    return parsed as Handle
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * The steps of a search
 * ------------------------------------------------------------------ */

/**
 * Where the chain has got to, carried in the `step` string.
 *
 * `library` and `series` are the first reply; the rest carry the ids found so
 * far, because there is nowhere else to put them.
 */
const STEP = {
  episodes: (seriesId: number) => `episodes:${seriesId}`,
  movieSubtitles: (radarrId: number) => `movie:${radarrId}`,
  episodeSubtitles: (seriesId: number, episodeId: number) => `episode:${seriesId}:${episodeId}`
}

/** Candidates, out of a `providers/movies` or `providers/episodes` reply. */
function readCandidates(
  entries: unknown[],
  make: (subtitle: string, language: string, hi: boolean, forced: boolean, originalFormat: boolean, from: string) => string
): SubtitleCandidate[] {
  const candidates: SubtitleCandidate[] = []

  for (const entry of entries) {
    const found = asRecord(entry)
    if (!found) continue

    const subtitle = asText(found.subtitle)
    const from = asText(found.provider)
    const language = asText(found.language)
    if (!subtitle || !from || !language) continue

    // Bazarr writes these as the strings `"True"` and `"False"`, which is what
    // `str()` of a Python bool gives; `asFlag` reads either that or a real one.
    const hi = asFlag(found.hearing_impaired) ?? false
    const forced = asFlag(found.forced) ?? false
    const originalFormat = asFlag(found.original_format) ?? false

    const matches = asArray(found.matches).map((match) => asText(match))
    const releases = asArray(found.release_info)
      .map((release) => asText(release))
      .filter((release): release is string => release !== undefined)

    // Bazarr's score is already a percentage of the best possible match for
    // this kind of media, so it is the one number here that means the same
    // thing across films and episodes.
    const score = asNumber(found.score)

    candidates.push({
      provider: BAZARR_ID,
      id: make(subtitle, language, hi, forced, originalFormat, from),
      language,
      release: releases[0],
      // `matches` is the set of things this subtitle agreed with the file
      // about. `hash` in it means a provider matched the file itself.
      hashMatch: matches.includes('hash'),
      hearingImpaired: hi,
      forced,
      rating: score === undefined ? undefined : Math.round(score) / 10,
      uploader: asText(found.uploader)
    })
  }

  return candidates
}

export const bazarr: SubtitleProvider = {
  id: BAZARR_ID,
  name: 'Bazarr',
  site: 'https://www.bazarr.media',
  needs: 'url-and-api-key',
  delivers: 'to-the-folder',
  summary:
    'Your own subtitle manager. Asks every provider you have set up in it, under your own languages and ' +
    'scoring, and saves the result beside the film itself.',

  search(query, credential) {
    const start = ready(credential)
    if (isProblem(start)) return start
    if (!query.filePath) {
      return { problem: 'Bazarr identifies a file by where it is, and this one has no path.' }
    }

    // Bazarr has no "which of your films is this file" endpoint, so the whole
    // list comes back and the match is made here. One request for a library of
    // any size, against one request per file for anything finer-grained.
    const what = isEpisode(query) ? 'series' : 'movies'
    return { url: `${start.base}/api/${what}?start=0&length=-1`, headers: headers(credential) }
  },

  readSearch(reply, query, step, credential) {
    const start = ready(credential ?? {})
    if (isProblem(start)) return start

    if (reply.status === 401) {
      return { problem: 'Bazarr rejected the API key.', hint: 'Check it under Services in Settings.', needsLogin: true }
    }
    if (reply.status >= 400) return { problem: `Bazarr answered ${reply.status}.` }

    const parsed = readJson(reply, 'Bazarr')
    if (isProblem(parsed)) return parsed
    const rows = asArray(asRecord(parsed)?.data)

    /* ---- the last step: the subtitles themselves ---- */

    if (step?.startsWith('movie:')) {
      const radarrId = Number(step.slice('movie:'.length))
      return readCandidates(rows, (subtitle, _language, hi, forced, originalFormat, from) =>
        pack({ kind: 'movie', id: radarrId, from, subtitle, hi, forced, originalFormat })
      )
    }

    if (step?.startsWith('episode:')) {
      const [seriesId, episodeId] = step.slice('episode:'.length).split(':').map(Number)
      return readCandidates(rows, (subtitle, _language, hi, forced, originalFormat, from) =>
        pack({ kind: 'episode', id: seriesId, episodeId, from, subtitle, hi, forced, originalFormat })
      )
    }

    /* ---- the middle step: which episode of the series ---- */

    if (step?.startsWith('episodes:')) {
      const seriesId = Number(step.slice('episodes:'.length))
      const episode = rows
        .map((row) => asRecord(row))
        .find((row) => {
          if (!row) return false
          // The path is the fact; the numbers are what somebody wrote in a file
          // name. Prefer the path and fall back only when it cannot be matched.
          if (samePath(asText(row.path), query.filePath)) return true
          return (
            asNumber(row.season) === query.season &&
            asNumber(row.episode) === query.episode &&
            asText(row.path) === undefined
          )
        })

      const episodeId = asNumber(episode?.sonarrEpisodeId)
      if (episodeId === undefined) {
        return { problem: 'Bazarr has that series, but no episode in it matching this file.' }
      }
      return {
        follow: {
          url: `${start.base}/api/providers/episodes?episodeid=${episodeId}`,
          headers: headers(credential ?? {})
        },
        step: STEP.episodeSubtitles(seriesId, episodeId)
      }
    }

    /* ---- the first step: which film, or which series ---- */

    if (isEpisode(query)) {
      const series = rows
        .map((row) => asRecord(row))
        .find((row) => row && underFolder(asText(row.path), query.filePath))
      const seriesId = asNumber(series?.sonarrSeriesId)
      if (seriesId === undefined) {
        return {
          problem: 'Bazarr has no series holding that file.',
          hint: 'It learns about a file from Sonarr, so a file Sonarr has not imported is not there yet.'
        }
      }
      return {
        follow: {
          url: `${start.base}/api/episodes?seriesid[]=${seriesId}`,
          headers: headers(credential ?? {})
        },
        step: STEP.episodes(seriesId)
      }
    }

    const movie = rows
      .map((row) => asRecord(row))
      .find((row) => row && samePath(asText(row.path), query.filePath))
    const radarrId = asNumber(movie?.radarrId)
    if (radarrId === undefined) {
      return {
        problem: 'Bazarr has no film at that path.',
        hint: 'It learns about a file from Radarr, so a file Radarr has not imported is not there yet.'
      }
    }
    return {
      follow: {
        url: `${start.base}/api/providers/movies?radarrid=${radarrId}`,
        headers: headers(credential ?? {})
      },
      step: STEP.movieSubtitles(radarrId)
    }
  },

  download(candidate, credential) {
    const start = ready(credential)
    if (isProblem(start)) return start
    const handle = unpack(candidate.id)
    if (!handle) return { problem: 'That result did not come from Bazarr.' }

    /*
     * Form-encoded, not JSON: these endpoints are built on Flask-RestX's
     * `reqparse`, which reads arguments out of the form and the query string.
     * The booleans travel as `True`/`False` because the handler calls
     * `.capitalize()` on them and compares against Python's own spelling.
     */
    const form = new URLSearchParams()
    if (handle.kind === 'movie') form.set('radarrid', String(handle.id))
    else {
      form.set('seriesid', String(handle.id))
      form.set('episodeid', String(handle.episodeId ?? 0))
    }
    form.set('hi', handle.hi ? 'True' : 'False')
    form.set('forced', handle.forced ? 'True' : 'False')
    form.set('original_format', handle.originalFormat ? 'True' : 'False')
    form.set('provider', handle.from)
    form.set('subtitle', handle.subtitle)

    return {
      url: `${start.base}/api/providers/${handle.kind === 'movie' ? 'movies' : 'episodes'}`,
      method: 'POST',
      headers: { ...headers(credential), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    }
  },

  readDownload(reply) {
    if (reply.status === 401) return { problem: 'Bazarr wants the API key again.', needsLogin: true }
    if (reply.status === 404) {
      return {
        problem: 'Bazarr no longer has that film.',
        hint: 'Search again — the result may be from before it was rescanned.'
      }
    }
    if (reply.status >= 400) {
      // The handler returns its own message with a 500 for anything it caught,
      // and that message is worth more than the number.
      const said = (reply.text ?? '').trim().replace(/^"|"$/g, '')
      return { problem: said === '' ? `Bazarr answered ${reply.status}.` : `Bazarr: ${said}` }
    }
    /*
     * A 204 and an empty body, which is all it ever says. The download has been
     * queued, not performed: nothing here knows yet whether it worked, and the
     * only way to find out is to look at the film's folder.
     */
    return { inTheFolder: true }
  },

  collect(candidate, credential) {
    const start = ready(credential)
    if (isProblem(start)) return start
    const handle = unpack(candidate.id)
    if (!handle) return { problem: 'That result did not come from Bazarr.' }

    // The same record the library listing carries, for one film or one
    // episode: `subtitles` on it is what Bazarr has indexed on disk.
    return {
      url:
        handle.kind === 'movie'
          ? `${start.base}/api/movies?radarrid[]=${handle.id}`
          : `${start.base}/api/episodes?episodeid[]=${handle.episodeId ?? 0}`,
      headers: headers(credential)
    }
  },

  readCollect(reply, candidate) {
    if (reply.status >= 400) return { problem: `Bazarr answered ${reply.status} when asked what it had saved.` }
    const parsed = readJson(reply, 'Bazarr')
    if (isProblem(parsed)) return parsed

    const row = asRecord(asArray(asRecord(parsed)?.data)[0])
    if (!row) return { saved: [] }

    // Bazarr reports the language as alpha-3 and alpha-2 side by side, and a
    // candidate carries whichever its own search returned. Compare against
    // both rather than picking one and being wrong half the time.
    const wanted = candidate.language.toLowerCase()
    const saved: SavedSubtitle[] = []

    for (const entry of asArray(row.subtitles)) {
      const subtitle = asRecord(entry)
      const path = asText(subtitle?.path)
      // A record with no path is a track already inside the film, which is not
      // something that was fetched into the folder.
      if (!path) continue
      const code2 = asText(subtitle?.code2)?.toLowerCase()
      const code3 = asText(subtitle?.code3)?.toLowerCase()
      if (code3 === wanted || code2 === wanted) {
        saved.push({ path, sizeBytes: asNumber(subtitle?.file_size) })
      }
    }

    return { saved }
  }
}
