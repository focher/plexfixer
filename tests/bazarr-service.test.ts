/**
 * The half of Bazarr that is not the provider: the service layer driving it.
 *
 * `bazarr-provider.test.ts` proves the requests and the readers. What that
 * cannot reach is everything the shape of this service forced on the layer
 * above it, and all three of those are ways a person could be handed the wrong
 * file and told it was right:
 *
 * - a search that takes three requests rather than one, and must stop;
 * - a download that answers `204` with nothing, so "it worked" has to be
 *   established by looking at the disk afterwards;
 * - a folder that may already have had a subtitle in this language, which must
 *   not be mistaken for the one just fetched.
 *
 * Nothing here touches a network or a disk. The transport is a function over a
 * table of saved replies and the host is a map of paths to bytes, which is what
 * lets the awkward cases — a stale subtitle, a container's path, a service that
 * never finishes — be set up exactly rather than waited for.
 */

import { describe, expect, it, vi } from 'vitest'
import { findSubtitles, fetchSubtitle, type Workshop } from '@shared/subtitles/service.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { isProblem, type HttpReply, type HttpRequest, type SubtitleCandidate } from '@shared/subtitles/providers/types.js'
import type { HostStat, RepairHost } from '@shared/host.js'
import { mkv, mainAudio, video } from './fixtures.js'

const FILM_PATH = '/Volumes/media/Films/Solaris (1972)/Solaris (1972).mkv'
/** What Bazarr, inside a container, calls the same folder. */
const BAZARR_PATH = '/movies/Solaris (1972)'

const SETTINGS = {
  ...DEFAULT_SETTINGS,
  subtitleProvider: 'bazarr',
  bazarrUrl: 'http://nas:6767',
  bazarrApiKey: 'a-bazarr-key',
  preferredSubtitleLanguage: 'eng'
}

const RESULT = analyzeFile(
  mkv([video(), mainAudio()], { path: FILM_PATH, fileName: 'Solaris (1972).mkv' }),
  SETTINGS
)

const MOVIES = { data: [{ radarrId: 11, title: 'Solaris', path: `${BAZARR_PATH}/Solaris (1972).mkv` }], total: 1 }

const OFFERED = {
  data: [
    {
      score: 98.5,
      forced: 'False',
      language: 'eng',
      hearing_impaired: 'False',
      provider: 'opensubtitles',
      subtitle: 'cache-key-aaa',
      original_format: false,
      matches: ['hash'],
      release_info: ['Solaris.1972.BluRay.1080p'],
      uploader: 'someone'
    }
  ]
}

const SRT = ['1', '00:00:01,000 --> 00:00:03,000', 'Kelvin.', '', '2', '00:00:04,000 --> 00:00:06,000', 'Hari.', ''].join('\n')
const OLD_SRT = ['1', '00:00:09,000 --> 00:00:11,000', 'Somebody else’s subtitle.', ''].join('\n')

/** One record as `GET /api/movies?radarrid[]=` returns it. */
const indexed = (subtitles: unknown[]): unknown => ({ data: [{ radarrId: 11, subtitles }], total: 1 })

const english = (path: string, sizeBytes: number): unknown => ({
  name: 'English',
  code2: 'en',
  code3: 'eng',
  path,
  file_size: sizeBytes
})

/* ------------------------------------------------------------------ *
 * A transport and a disk, both made of tables
 * ------------------------------------------------------------------ */

/**
 * Replies keyed by what the URL ends in, so a test says what the service
 * answers rather than in what order it was asked.
 *
 * A reply may be a list, which is consumed one call at a time: that is how
 * "nothing there yet, nothing there yet, there it is" is set up, which is the
 * only shape a queued download ever has.
 */
type Table = Record<string, unknown | unknown[]>

function transport(table: Table): { net: Workshop['net']; asked: string[] } {
  const asked: string[] = []
  const pending = new Map<string, unknown[]>()

  const fetch = async (request: HttpRequest): Promise<HttpReply> => {
    asked.push(`${request.method ?? 'GET'} ${request.url}`)
    const key = Object.keys(table).find((candidate) => request.url.includes(candidate))
    if (key === undefined) return { status: 404, text: 'no such saved reply' }

    const value = table[key]
    if (Array.isArray(value)) {
      const left = pending.get(key) ?? [...value]
      const next = left.length > 1 ? (left.shift() as unknown) : left[0]
      pending.set(key, left)
      return { status: 200, text: JSON.stringify(next) }
    }
    if (value === null) return { status: 204, text: '' }
    return { status: 200, text: JSON.stringify(value) }
  }

  return { net: { fetch, upload: async () => ({ status: 500 }) } as Workshop['net'], asked }
}

/** A disk that is a map of path to contents, and nothing else. */
function disk(files: Record<string, string>): RepairHost {
  const bytes = (path: string): Uint8Array | undefined => {
    const text = files[path]
    return text === undefined ? undefined : new TextEncoder().encode(text)
  }
  return {
    kind: 'local',
    label: 'this machine',
    paths: {
      join: (...parts: string[]) => parts.join('/'),
      dirname: (value: string) => value.slice(0, value.lastIndexOf('/')),
      basename: (value: string) => value.slice(value.lastIndexOf('/') + 1),
      extname: (value: string) => value.slice(value.lastIndexOf('.')),
      relative: () => '',
      isAbsolute: (value: string) => value.startsWith('/'),
      sep: '/'
    },
    exec: async () => '',
    stat: async (path: string): Promise<HostStat | undefined> => {
      const found = bytes(path)
      return found ? { sizeBytes: found.length, isDirectory: false } : undefined
    },
    list: async () => [],
    readRange: async (path: string, offset: number, length: number) =>
      (bytes(path) ?? new Uint8Array()).slice(offset, offset + length)
  } as unknown as RepairHost
}

function shopWith(table: Table, files: Record<string, string> = {}): Workshop & { asked: string[] } {
  const { net, asked } = transport(table)
  return { settings: SETTINGS, host: disk(files), net, ffmpegPath: '/ffmpeg', asked }
}

/**
 * A fetch with the minute of waiting taken out of it.
 *
 * The wait is the point of this code and is the one thing not worth testing in
 * real time: a queued download that never arrives takes the full schedule, and
 * three of these would be most of two minutes. The clock is driven forward
 * instead, which exercises exactly the same loop.
 */
async function fetchWithTheClockRunning(
  shop: Workshop,
  candidate: SubtitleCandidate,
  mediaPath: string | undefined,
  signal?: AbortSignal
): ReturnType<typeof fetchSubtitle> {
  vi.useFakeTimers()
  try {
    const pending = fetchSubtitle(shop, candidate, mediaPath, undefined, signal)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    // In slices, so that each sleep and the request that follows it both get
    // their turn; `advanceTimersByTimeAsync` flushes the promises between.
    for (let slice = 0; slice < 60 && !settled; slice += 1) await vi.advanceTimersByTimeAsync(5_000)
    return await pending
  } finally {
    vi.useRealTimers()
  }
}

/* ------------------------------------------------------------------ *
 * Searching, which takes more than one request
 * ------------------------------------------------------------------ */

describe('a search that takes three requests', () => {
  it('follows the chain to the subtitles without the caller knowing there was one', async () => {
    const shop = shopWith({ '/api/movies?start=0': MOVIES, '/api/providers/movies?radarrid=11': OFFERED })

    const found = await findSubtitles(shop, RESULT)
    if (isProblem(found)) throw new Error(found.problem)

    expect(found).toHaveLength(1)
    expect(found[0].provider).toBe('bazarr')
    expect(found[0].hashMatch).toBe(true)
    expect(shop.asked).toEqual([
      'GET http://nas:6767/api/movies?start=0&length=-1',
      'GET http://nas:6767/api/providers/movies?radarrid=11'
    ])
  })

  it('does not spend two reads of the film on a hash Bazarr has no use for', async () => {
    // The film has to be readable, or the hash would fail at the first stat
    // and this would pass for the wrong reason.
    const shop = shopWith({ '/api/movies?start=0': MOVIES, '/api/providers/movies?radarrid=11': OFFERED }, {
      [FILM_PATH]: 'x'.repeat(200_000)
    })
    const reading = vi.spyOn(shop.host, 'readRange')

    await findSubtitles(shop, RESULT)
    // Bazarr identifies the file by its path. The two 64 KB reads a hash costs
    // are free locally and are a round trip each over SSH.
    expect(reading).not.toHaveBeenCalled()
  })

  it('ends after a handful of requests whatever comes back', async () => {
    /*
     * Every address here answers with the library listing, so no reply is the
     * one the chain was expecting. Neither shipped provider can be made to
     * loop — Bazarr's steps are named and each name is read once — so the
     * ceiling in `findSubtitles` is there for a provider not yet written
     * rather than for these. What is worth asserting is the property it
     * protects: a search ends, and ends having asked a countable number of
     * times, rather than leaving the dialog spinning with no way out.
     */
    const shop = shopWith({ '/api/': MOVIES })
    const found = await findSubtitles(shop, RESULT)
    expect(isProblem(found) ? [] : found).toEqual([])
    expect(shop.asked.length).toBeLessThanOrEqual(5)
  })

  it('passes a refusal from the middle of the chain straight back', async () => {
    const shop = shopWith({ '/api/movies?start=0': { data: [], total: 0 } })
    const found = await findSubtitles(shop, RESULT)
    expect(isProblem(found) && found.problem).toContain('no film at that path')
  })
})

/* ------------------------------------------------------------------ *
 * A download that answers with nothing
 * ------------------------------------------------------------------ */

describe('a download that is only a promise to download', () => {
  const candidateFrom = async (shop: Workshop) => {
    const found = await findSubtitles(shop, RESULT)
    if (isProblem(found)) throw new Error(found.problem)
    return found[0]
  }

  it('waits for the file to appear and then reads it from beside the film', async () => {
    const shop = shopWith(
      {
        '/api/movies?start=0': MOVIES,
        '/api/providers/movies?radarrid=11': OFFERED,
        // Nothing, nothing, then the subtitle: a queued download, which is the
        // only kind Bazarr does.
        '/api/movies?radarrid[]=11': [
          indexed([]),
          indexed([]),
          indexed([english(`${BAZARR_PATH}/Solaris (1972).en.srt`, SRT.length)])
        ],
        '/api/providers/movies': null
      },
      // Bazarr saved it into a path this machine does not have, under a name
      // this machine does.
      { '/Volumes/media/Films/Solaris (1972)/Solaris (1972).en.srt': SRT }
    )

    const got = await fetchWithTheClockRunning(shop, await candidateFrom(shop), FILM_PATH)
    if (isProblem(got)) throw new Error(got.problem)

    expect(got.cues).toHaveLength(2)
    expect(got.cues[0].text).toBe('Kelvin.')
    expect(shop.asked).toContain('POST http://nas:6767/api/providers/movies')
  })

  it('does not hand back a subtitle that was already there', async () => {
    /*
     * The case that makes this whole dance necessary. The film already has an
     * English subtitle; the download is queued and never completes. Asking
     * "is there an English subtitle" would answer yes immediately and hand
     * over somebody else's file as though it were the one just fetched.
     */
    const stale = english(`${BAZARR_PATH}/Solaris (1972).en.srt`, OLD_SRT.length)
    const shop = shopWith(
      {
        '/api/movies?start=0': MOVIES,
        '/api/providers/movies?radarrid=11': OFFERED,
        '/api/movies?radarrid[]=11': indexed([stale]),
        '/api/providers/movies': null
      },
      { '/Volumes/media/Films/Solaris (1972)/Solaris (1972).en.srt': OLD_SRT }
    )

    const got = await fetchWithTheClockRunning(shop, await candidateFrom(shop), FILM_PATH)
    expect(isProblem(got) && got.problem).toContain('did not save a subtitle')
  })

  it('notices a replacement of the same name, by its size', async () => {
    // Bazarr overwrites `Solaris (1972).en.srt` with a better one. The path
    // has not changed, so only the size says anything happened.
    const shop = shopWith(
      {
        '/api/movies?start=0': MOVIES,
        '/api/providers/movies?radarrid=11': OFFERED,
        '/api/movies?radarrid[]=11': [
          indexed([english(`${BAZARR_PATH}/Solaris (1972).en.srt`, OLD_SRT.length)]),
          indexed([english(`${BAZARR_PATH}/Solaris (1972).en.srt`, SRT.length)])
        ],
        '/api/providers/movies': null
      },
      { '/Volumes/media/Films/Solaris (1972)/Solaris (1972).en.srt': SRT }
    )

    const got = await fetchWithTheClockRunning(shop, await candidateFrom(shop), FILM_PATH)
    if (isProblem(got)) throw new Error(got.problem)
    expect(got.cues[0].text).toBe('Kelvin.')
  })

  it('reads the path Bazarr gave when the two machines agree about it', async () => {
    const shop = shopWith(
      {
        '/api/movies?start=0': MOVIES,
        '/api/providers/movies?radarrid=11': OFFERED,
        '/api/movies?radarrid[]=11': [indexed([]), indexed([english(`${BAZARR_PATH}/other-name.srt`, SRT.length)])],
        '/api/providers/movies': null
      },
      { '/movies/Solaris (1972)/other-name.srt': SRT }
    )

    const got = await fetchWithTheClockRunning(shop, await candidateFrom(shop), FILM_PATH)
    if (isProblem(got)) throw new Error(got.problem)
    expect(got.cues).toHaveLength(2)
  })

  it('says which film it needed rather than reading something at random', async () => {
    const shop = shopWith({
      '/api/movies?start=0': MOVIES,
      '/api/providers/movies?radarrid=11': OFFERED,
      '/api/movies?radarrid[]=11': indexed([]),
      '/api/providers/movies': null
    })

    const got = await fetchWithTheClockRunning(shop, await candidateFrom(shop), undefined)
    expect(isProblem(got) && got.problem).toContain('nothing said which film')
  })

  it('stops when it is told to, instead of sitting out the whole minute', async () => {
    const shop = shopWith({
      '/api/movies?start=0': MOVIES,
      '/api/providers/movies?radarrid=11': OFFERED,
      '/api/movies?radarrid[]=11': indexed([]),
      '/api/providers/movies': null
    })

    const controller = new AbortController()
    const candidate = await candidateFrom(shop)
    // Aborted before the first sleep is even reached, which is the case a
    // listener added after the fact would have missed: it would have slept
    // the whole schedule out and only then noticed.
    controller.abort()

    const got = await fetchSubtitle(shop, candidate, FILM_PATH, undefined, controller.signal)
    expect(isProblem(got) && got.problem).toBe('Stopped.')
  })
})
