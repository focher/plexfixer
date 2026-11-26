import { describe, expect, it } from 'vitest'
import { openSubtitles, serviceLanguages, remainingDownloads } from '@shared/subtitles/providers/opensubtitles.js'
import {
  isProblem,
  isStep,
  type HttpReply,
  type ProviderProblem,
  type SubtitleCandidate,
  type SubtitleQuery,
  type SubtitleStep
} from '@shared/subtitles/providers/types.js'
import { PROVIDERS, providerById } from '@shared/subtitles/providers/index.js'

const KEY = { apiKey: 'a-key-of-your-own' }
const SIGNED_IN = { ...KEY, username: 'someone', password: 'secret', token: 'a-token' }

/** Shorthand for the happy path, which every test here needs. */
function request(query: Partial<SubtitleQuery>, credential = KEY): URL {
  const built = openSubtitles.search({ languages: ['eng'], ...query }, credential)
  if (isProblem(built)) throw new Error(built.problem)
  return new URL(built.url)
}

function reply(body: unknown, status = 200): HttpReply {
  return { status, text: typeof body === 'string' ? body : JSON.stringify(body) }
}

/**
 * The candidates, or a failure that says which of the other two answers came
 * back instead. A search may now answer with another request to make, which is
 * never what a OpenSubtitles test is asking for.
 */
function candidates(found: SubtitleCandidate[] | SubtitleStep | ProviderProblem): SubtitleCandidate[] {
  if (isProblem(found)) throw new Error(found.problem)
  if (isStep(found)) throw new Error(`wanted candidates, got a follow-up to ${found.follow.url}`)
  return found
}

describe('the registry', () => {
  it('has no two providers claiming the same id', () => {
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length)
  })

  it('finds a provider by id and nothing by a made-up one', () => {
    expect(providerById('opensubtitles')).toBe(openSubtitles)
    expect(providerById('nothing-like-it')).toBeUndefined()
  })
})

describe('language codes', () => {
  it('speaks the two-letter codes the service does', () => {
    expect(serviceLanguages(['eng', 'rus'])).toEqual(['en', 'ru'])
  })

  it('asks for both halves of a language the service splits', () => {
    // One language here, two catalogues there; asking for `pt` returns neither.
    expect(serviceLanguages(['por'])).toEqual(['pt-br', 'pt-pt'])
    expect(serviceLanguages(['chi'])).toEqual(['zh-cn', 'zh-tw'])
  })

  it('sorts and de-duplicates, which the service insists on', () => {
    expect(serviceLanguages(['rus', 'eng', 'ru', 'eng'])).toEqual(['en', 'ru'])
  })

  it('drops a code with no two-letter form rather than inventing one', () => {
    // Taking the first two letters of a three-letter code produces real codes
    // for the wrong languages.
    expect(serviceLanguages(['qqq'])).toEqual([])
  })
})

describe('searching', () => {
  it('refuses to build a request with no key', () => {
    const built = openSubtitles.search({ languages: ['eng'] }, {})
    expect(isProblem(built) && built.problem).toContain('API key')
  })

  it('refuses when nothing asked for has a code the service knows', () => {
    const built = openSubtitles.search({ languages: ['qqq'] }, KEY)
    expect(isProblem(built) && built.problem).toContain('recognises')
  })

  it('only ever addresses the one host', () => {
    expect(request({ title: 'Solaris' }).origin).toBe('https://api.opensubtitles.com')
    expect(request({ title: 'Solaris' }).pathname).toBe('/api/v1/subtitles')
  })

  it('sends the hash instead of the title when there is one', () => {
    const withHash = request({ movieHash: '8e245d9679d31e12', title: 'Solaris' })
    expect(withHash.searchParams.get('moviehash')).toBe('8e245d9679d31e12')
    // The title is left off on purpose: the service returns name matches
    // alongside the hash match either way, and the hash is the better key.
    expect(withHash.searchParams.get('query')).toBeNull()

    const withoutHash = request({ title: 'Solaris' })
    expect(withoutHash.searchParams.get('query')).toBe('Solaris')
  })

  it('asks about an episode as an episode', () => {
    const url = request({ title: 'Chernobyl', season: 1, episode: 3, year: 2019 })
    expect(url.searchParams.get('type')).toBe('episode')
    expect(url.searchParams.get('season_number')).toBe('1')
    expect(url.searchParams.get('episode_number')).toBe('3')
    // A year narrows a film and wrongly excludes an episode of a series that
    // ran across two of them.
    expect(url.searchParams.get('year')).toBeNull()
  })

  it('asks about a film as a film, with its year', () => {
    const url = request({ title: 'Solaris', year: 1972 })
    expect(url.searchParams.get('type')).toBe('movie')
    expect(url.searchParams.get('year')).toBe('1972')
  })

  it('strips the tt from an IMDb id, which the service does not want', () => {
    expect(request({ imdbId: 'tt0069293' }).searchParams.get('imdb_id')).toBe('0069293')
  })

  it('leaves out every parameter it has no value for', () => {
    const url = request({ title: 'Solaris' })
    expect([...url.searchParams.keys()].sort()).toEqual(['languages', 'query', 'type'])
  })

  it('carries the key in a header, never in the address', () => {
    const built = openSubtitles.search({ languages: ['eng'], title: 'Solaris' }, KEY)
    if (isProblem(built)) throw new Error(built.problem)
    expect(built.headers?.['Api-Key']).toBe('a-key-of-your-own')
    expect(built.url).not.toContain('a-key-of-your-own')
  })
})

/* ------------------------------------------------------------------ *
 * Reading a reply
 * ------------------------------------------------------------------ */

const SEARCH_REPLY = {
  total_count: 2,
  data: [
    {
      id: '7331',
      type: 'subtitle',
      attributes: {
        subtitle_id: '7331',
        language: 'ru',
        download_count: 1402,
        hearing_impaired: false,
        foreign_parts_only: false,
        machine_translated: false,
        ai_translated: false,
        moviehash_match: true,
        ratings: 8.5,
        release: 'Solaris.1972.BluRay.1080p',
        uploader: { uploader_id: 1, name: 'someone', rank: 'trusted' },
        files: [{ file_id: 990001, cd_number: 1, file_name: 'Solaris.1972.ru.srt' }]
      }
    },
    {
      id: '7332',
      attributes: {
        language: 'en',
        download_count: 55,
        hearing_impaired: true,
        ai_translated: true,
        ratings: 0,
        release: 'Solaris.1972.DVDRip',
        files: [
          { file_id: 990002, cd_number: 1, file_name: 'Solaris.CD1.srt' },
          { file_id: 990003, cd_number: 2, file_name: 'Solaris.CD2.srt' }
        ]
      }
    }
  ]
}

describe('reading a search reply', () => {
  const query: SubtitleQuery = { languages: ['eng', 'rus'] }

  it('reads what matters off each candidate', () => {
    const found = candidates(openSubtitles.readSearch(reply(SEARCH_REPLY), query))

    expect(found).toHaveLength(2)
    expect(found[0]).toEqual({
      provider: 'opensubtitles',
      // The *file* id, not the subtitle id: that is what a download asks for.
      id: '990001',
      language: 'rus',
      release: 'Solaris.1972.BluRay.1080p',
      fileName: 'Solaris.1972.ru.srt',
      hashMatch: true,
      hearingImpaired: false,
      forced: false,
      machineTranslated: false,
      downloads: 1402,
      rating: 8.5,
      uploader: 'someone',
      parts: undefined
    })
  })

  it('counts a subtitle split across discs so the UI can warn about it', () => {
    const found = candidates(openSubtitles.readSearch(reply(SEARCH_REPLY), query))
    expect(found[1].parts).toBe(2)
    expect(found[1].id).toBe('990002')
  })

  it('treats an AI translation as machine translated, whichever flag says so', () => {
    const found = candidates(openSubtitles.readSearch(reply(SEARCH_REPLY), query))
    expect(found[1].machineTranslated).toBe(true)
  })

  it('drops a language nobody asked for', () => {
    const found = candidates(openSubtitles.readSearch(reply(SEARCH_REPLY), { languages: ['rus'] }))
    expect(found.map((c) => c.language)).toEqual(['rus'])
  })

  it('skips a row with no file to download rather than losing the rest', () => {
    const found = candidates(
      openSubtitles.readSearch(reply({ data: [{ attributes: { language: 'en', files: [] } }, ...SEARCH_REPLY.data] }), query)
    )
    expect(found).toHaveLength(2)
  })

  it('survives a reply that is nothing like the documented one', () => {
    for (const body of [{}, { data: 'not an array' }, { data: [null, 7, 'x'] }, []]) {
      const found = openSubtitles.readSearch(reply(body), query)
      expect(isProblem(found) ? [] : found).toEqual([])
    }
  })

  it('says what went wrong rather than throwing', () => {
    expect(isProblem(openSubtitles.readSearch(reply('<html>nope</html>'), query))).toBe(true)
    const unauthorised = openSubtitles.readSearch(reply({ message: 'invalid api key' }, 401), query)
    expect(isProblem(unauthorised) && unauthorised.problem).toContain('invalid api key')
    const throttled = openSubtitles.readSearch(reply({}, 429), query)
    expect(isProblem(throttled) && throttled.problem).toContain('fewer requests')
    expect(isProblem(openSubtitles.readSearch(reply(''), query))).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Signing in and downloading
 * ------------------------------------------------------------------ */

describe('signing in', () => {
  it('asks for a username and password before trying', () => {
    const built = openSubtitles.login?.(KEY)
    expect(built && isProblem(built) && built.needsLogin).toBe(true)
  })

  it('posts them as JSON, and never in the address', () => {
    const built = openSubtitles.login?.(SIGNED_IN)
    if (!built || isProblem(built)) throw new Error('expected a request')
    expect(built.method).toBe('POST')
    expect(built.url).toBe('https://api.opensubtitles.com/api/v1/login')
    expect(JSON.parse(built.body ?? '{}')).toEqual({ username: 'someone', password: 'secret' })
    expect(built.url).not.toContain('secret')
  })

  it('reads the token out, and says plainly when the sign-in was refused', () => {
    expect(openSubtitles.readLogin?.(reply({ token: 'abc', status: 200 }))).toEqual({ token: 'abc' })
    const refused = openSubtitles.readLogin?.(reply({}, 401))
    expect(refused && isProblem(refused) && refused.problem).toContain('did not accept')
  })
})

describe('downloading', () => {
  const candidate = {
    provider: 'opensubtitles',
    id: '990001',
    language: 'rus',
    hashMatch: true
  }

  it('will not try without a token, and says signing in is what is missing', () => {
    const built = openSubtitles.download(candidate, KEY)
    expect(isProblem(built) && built.needsLogin).toBe(true)
  })

  it('asks for the file by id', () => {
    const built = openSubtitles.download(candidate, SIGNED_IN)
    if (isProblem(built)) throw new Error(built.problem)
    expect(built.url).toBe('https://api.opensubtitles.com/api/v1/download')
    expect(JSON.parse(built.body ?? '{}')).toEqual({ file_id: 990001 })
    expect(built.headers?.Authorization).toBe('Bearer a-token')
  })

  it('follows the link the reply gives, asking for bytes not text', () => {
    const next = openSubtitles.readDownload(reply({ link: 'https://dl.opensubtitles.com/x/Solaris.ru.srt', remaining: 4 }))
    expect(next).toEqual({ follow: { url: 'https://dl.opensubtitles.com/x/Solaris.ru.srt', binary: true } })
  })

  it('explains a spent allowance instead of reporting a bare number', () => {
    const refused = openSubtitles.readDownload(reply({ reset_time: '3 hours' }, 406))
    expect(isProblem(refused) && refused.problem).toContain('used up its downloads')
    expect(isProblem(refused) && refused.hint).toContain('3 hours')
  })

  it('reports a reply with no link at all', () => {
    const refused = openSubtitles.readDownload(reply({ message: 'something else' }, 200))
    expect(isProblem(refused) && refused.problem).toBe('something else')
  })

  it('reads the allowance off any download reply, refused or not', () => {
    expect(remainingDownloads(reply({ requests: 6, remaining: 94 }))).toEqual({ used: 6, remaining: 94 })
    expect(remainingDownloads(reply('not json'))).toEqual({})
  })
})
