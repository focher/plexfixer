import { describe, expect, it } from 'vitest'
import type { Cue } from '@shared/subtitles/cues.js'
import { scaleCues, shiftCues } from '@shared/subtitles/cues.js'
import { speechFraction, speechIntervals } from '@shared/subtitles/silence.js'
import { analyseSync, applySync, cueHitRate } from '@shared/subtitles/sync.js'
import { movieHashFrom, movieHash, HASH_CHUNK_BYTES } from '@shared/subtitles/hash.js'

/* ------------------------------------------------------------------ *
 * A film, made up
 * ------------------------------------------------------------------ */

/** Deterministic noise, so a failure is reproducible rather than occasional. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Lines of dialogue spread across a film, as both cues and the speech they
 * sit in. A real film's speech also covers music and effects, so the speech
 * timeline is deliberately wider than the cues: that is the asymmetry the
 * correlation has to survive.
 */
function film(durationMs: number, seed = 7): { cues: Cue[]; speech: { startMs: number; endMs: number }[] } {
  const next = rng(seed)
  const cues: Cue[] = []
  const speech: { startMs: number; endMs: number }[] = []
  let at = 2000

  while (at < durationMs - 6000) {
    const length = 1200 + Math.floor(next() * 2600)
    cues.push({ startMs: at, endMs: at + length, text: `line at ${at}` })
    // The sound starts a little before the line and runs the same little past
    // it. Symmetric, because padding one side more than the other makes every
    // shift inside the slack equally correct and the test would be measuring
    // the fixture; and narrow, because the slack is exactly the width of the
    // band within which no answer is better than any other.
    speech.push({ startMs: Math.max(0, at - 150), endMs: at + length + 150 })
    at += length + 900 + Math.floor(next() * 3200)
  }

  // Two stretches of music, loud and wordless.
  speech.push({ startMs: Math.floor(durationMs * 0.1), endMs: Math.floor(durationMs * 0.14) })
  speech.push({ startMs: Math.floor(durationMs * 0.6), endMs: Math.floor(durationMs * 0.66) })

  return { cues, speech: speech.sort((a, b) => a.startMs - b.startMs) }
}

const TWENTY_MINUTES = 20 * 60 * 1000

/* ------------------------------------------------------------------ *
 * silencedetect
 * ------------------------------------------------------------------ */

describe('speech intervals', () => {
  it('inverts what silencedetect reported', () => {
    const stderr = [
      '[silencedetect @ 0x7f] silence_start: 0',
      '[silencedetect @ 0x7f] silence_end: 2.5 | silence_duration: 2.5',
      '[silencedetect @ 0x7f] silence_start: 10.25',
      '[silencedetect @ 0x7f] silence_end: 12 | silence_duration: 1.75'
    ].join('\n')
    expect(speechIntervals(stderr, 20)).toEqual([
      { startMs: 2500, endMs: 10_250 },
      { startMs: 12_000, endMs: 20_000 }
    ])
  })

  it('closes a silence that was still open when the file ended', () => {
    const stderr = '[silencedetect @ 0x7f] silence_start: 95.5'
    expect(speechIntervals(stderr, 100)).toEqual([{ startMs: 0, endMs: 95_500 }])
  })

  it('treats a film with no reported silence as speech throughout', () => {
    expect(speechIntervals('', 60)).toEqual([{ startMs: 0, endMs: 60_000 }])
  })

  it('does not let a negative start put the film before itself', () => {
    const stderr = '[silencedetect @ 0x7f] silence_start: -0.001\n[silencedetect @ 0x7f] silence_end: 3'
    expect(speechIntervals(stderr, 10)[0]).toEqual({ startMs: 3000, endMs: 10_000 })
  })

  it('reports how much of the film has sound in it', () => {
    expect(speechFraction([{ startMs: 0, endMs: 30_000 }], 60)).toBeCloseTo(0.5, 5)
    expect(speechFraction([], 60)).toBe(0)
    expect(speechFraction([{ startMs: 0, endMs: 1000 }], 0)).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * Alignment
 * ------------------------------------------------------------------ */

describe('sync analysis', () => {
  it('says so when there is nothing to compare', () => {
    expect(analyseSync([], [{ startMs: 0, endMs: 1000 }], 600).state).toBe('unknown')
    expect(analyseSync(film(TWENTY_MINUTES).cues, [], 600).state).toBe('unknown')
    // Too short for a correlation to mean anything.
    const short = film(60_000)
    expect(analyseSync(short.cues, short.speech, 60).state).toBe('unknown')
  })

  it('recognises a subtitle that is already in step', () => {
    const { cues, speech } = film(TWENTY_MINUTES)
    const report = analyseSync(cues, speech, TWENTY_MINUTES / 1000)
    expect(report.state).toBe('in-sync')
    expect(report.offsetMs).toBe(0)
    expect(report.confidence).toBe('good')
    expect(report.cueHitRateAsIs).toBeGreaterThan(0.95)
  })

  it('finds a constant offset and which way it goes', () => {
    const { cues, speech } = film(TWENTY_MINUTES)
    // The lines run three seconds early, so they need moving later.
    const early = shiftCues(cues, -3000)
    const report = analyseSync(early, speech, TWENTY_MINUTES / 1000)

    expect(report.state).toBe('offset')
    expect(report.offsetMs).toBeGreaterThan(2825)
    expect(report.offsetMs).toBeLessThan(3175)
    expect(report.confidence).toBe('good')
    expect(report.summary).toContain('early')
    // Applying the report puts them back where they belong.
    expect(cueHitRate(applySync(early, report), speech)).toBeGreaterThan(0.95)
  })

  it('finds an offset the other way round too', () => {
    const { cues, speech } = film(TWENTY_MINUTES, 11)
    const late = shiftCues(cues, 4500)
    const report = analyseSync(late, speech, TWENTY_MINUTES / 1000)
    expect(report.state).toBe('offset')
    expect(report.offsetMs).toBeLessThan(-4325)
    expect(report.offsetMs).toBeGreaterThan(-4675)
    expect(report.summary).toContain('late')
  })

  it('recognises the PAL speedup and names it', () => {
    const { cues, speech } = film(TWENTY_MINUTES, 3)
    // A subtitle timed against a 25 fps transfer, over a 23.976 fps source:
    // its own times are the film's times divided by the ratio.
    const drifting = scaleCues(cues, 23.976 / 25, 0)
    const report = analyseSync(drifting, speech, TWENTY_MINUTES / 1000)

    expect(report.state).toBe('drifting')
    expect(report.factor).toBeCloseTo(25 / 23.976, 3)
    expect(report.factorLabel).toContain('PAL speedup')
    expect(Math.abs(report.offsetMs)).toBeLessThan(400)
    expect(cueHitRate(applySync(drifting, report), speech)).toBeGreaterThan(0.9)
  })

  it('does not call an in-step subtitle drifting', () => {
    const { cues, speech } = film(TWENTY_MINUTES, 23)
    expect(analyseSync(cues, speech, TWENTY_MINUTES / 1000).factor).toBe(1)
  })

  it('refuses to align a subtitle for a different film', () => {
    const { speech } = film(TWENTY_MINUTES, 5)
    const somethingElse = film(TWENTY_MINUTES, 999).cues
    const report = analyseSync(somethingElse, speech, TWENTY_MINUTES / 1000)

    expect(report.state).toBe('mismatched')
    expect(report.offsetMs).toBe(0)
    expect(report.factor).toBe(1)
    expect(report.summary).toContain('different')
  })

  it('lands in the middle of a run of equally good shifts, not at an end', () => {
    // One line, and half a second of room either side of it: every shift in
    // that second is exactly as good as every other, and the middle is the one
    // furthest from being wrong. Picking an end was a real bug — it reported a
    // four and a half second offset as four thousand two hundred milliseconds.
    //
    // The gaps are irregular on purpose: lines spaced exactly evenly correlate
    // just as well one whole gap out as they do in the right place, and the
    // analysis is right to refuse that as ambiguous rather than to guess.
    const next = rng(77)
    const cues: Cue[] = []
    const speech: { startMs: number; endMs: number }[] = []
    let at = 5000
    while (at < 880_000) {
      cues.push({ startMs: at, endMs: at + 2000, text: `line ${at}` })
      speech.push({ startMs: at - 500, endMs: at + 2500 })
      at += 4000 + Math.floor(next() * 6000)
    }
    const report = analyseSync(shiftCues(cues, -6000), speech, 900)
    expect(report.state).toBe('offset')
    expect(Math.abs(report.offsetMs - 6000)).toBeLessThanOrEqual(100)
  })

  it('does not invent a stretch to fit a subtitle that fits nothing', () => {
    // Nine ratios across thousands of shifts each is twenty thousand attempts
    // at fitting noise, and the best of those beats the best of two thousand
    // often enough that this used to come back as "drifting by 4%".
    const { speech } = film(TWENTY_MINUTES, 41)
    for (const seed of [101, 202, 303, 404]) {
      const report = analyseSync(film(TWENTY_MINUTES, seed).cues, speech, TWENTY_MINUTES / 1000)
      expect(report.state, `seed ${seed}`).toBe('mismatched')
      expect(report.factor, `seed ${seed}`).toBe(1)
    }
  })

  it('reports the baseline a hit rate should be read against', () => {
    const { cues, speech } = film(TWENTY_MINUTES, 13)
    const report = analyseSync(cues, speech, TWENTY_MINUTES / 1000)
    expect(report.speechShare).toBeGreaterThan(0.3)
    expect(report.speechShare).toBeLessThan(1)
    // The whole point of carrying it: the hit rate has to beat it to mean
    // anything, and on a correctly timed subtitle it does, clearly.
    expect(report.cueHitRateAsIs).toBeGreaterThan(report.speechShare + 0.1)
    expect(report.summary).toContain('at random')
  })

  it('gets through a two-hour film quickly enough to run on a click', () => {
    const TWO_HOURS = 2 * 60 * 60 * 1000
    const { cues, speech } = film(TWO_HOURS, 17)
    const started = performance.now()
    const report = analyseSync(shiftCues(cues, -2000), speech, TWO_HOURS / 1000)
    const took = performance.now() - started
    expect(report.state).toBe('offset')
    // The sweep is nine full-range correlations over a two-hour timeline. It is
    // meant to cost a moment, not a coffee break.
    expect(took).toBeLessThan(8000)
  })

  it('counts the lines that begin while somebody is speaking', () => {
    const speech = [{ startMs: 1000, endMs: 5000 }]
    const cues: Cue[] = [
      { startMs: 1500, endMs: 2500, text: 'inside' },
      { startMs: 60_000, endMs: 61_000, text: 'nowhere near' }
    ]
    expect(cueHitRate(cues, speech)).toBe(0.5)
    expect(cueHitRate([], speech)).toBe(0)
    expect(cueHitRate(cues, [])).toBe(0)
  })
})

describe('applying a report', () => {
  it('stretches before it shifts', () => {
    const cues: Cue[] = [{ startMs: 1000, endMs: 2000, text: 'A' }]
    const applied = applySync(cues, {
      state: 'drifting',
      confidence: 'good',
      offsetMs: 500,
      factor: 2,
      score: 0.5,
      scoreAsIs: 0.1,
      margin: 0.2,
      cueHitRate: 0.9,
      cueHitRateAsIs: 0.2,
      speechShare: 0.6,
      summary: ''
    })
    // 1000 doubled is 2000, then shifted is 2500. Shifting first would give 3000.
    expect(applied[0].startMs).toBe(2500)
  })
})

/* ------------------------------------------------------------------ *
 * The file hash
 * ------------------------------------------------------------------ */

describe('movie hash', () => {
  const chunk = (words: bigint[]): Uint8Array => {
    const bytes = new Uint8Array(HASH_CHUNK_BYTES)
    const view = new DataView(bytes.buffer)
    words.forEach((word, index) => view.setBigUint64(index * 8, word, true))
    return bytes
  }

  it('adds the size to both ends, read as little-endian words', () => {
    expect(movieHashFrom(1000, chunk([1n]), chunk([]))).toBe('00000000000003e9')
    expect(movieHashFrom(0, chunk([0x0102030405060708n]), chunk([0x1000000000000000n]))).toBe('1102030405060708')
  })

  it('wraps at sixty-four bits, which is the specification', () => {
    expect(movieHashFrom(0, chunk([0xffffffffffffffffn]), chunk([3n]))).toBe('0000000000000002')
  })

  it('reads both ends of the file and nothing in between', async () => {
    const reads: { offset: number; length: number }[] = []
    const hash = await movieHash('/films/a.mkv', {
      stat: async () => ({ sizeBytes: 5_000_000 }),
      readRange: async (_path, offset, length) => {
        reads.push({ offset, length })
        return chunk([7n])
      }
    })
    expect(reads).toEqual([
      { offset: 0, length: HASH_CHUNK_BYTES },
      { offset: 5_000_000 - HASH_CHUNK_BYTES, length: HASH_CHUNK_BYTES }
    ])
    expect(hash).toBe(movieHashFrom(5_000_000, chunk([7n]), chunk([7n])))
  })

  it('has no hash for a file too small to have two ends', async () => {
    const hash = await movieHash('/films/tiny.mkv', {
      stat: async () => ({ sizeBytes: 100 }),
      readRange: async () => new Uint8Array(100)
    })
    expect(hash).toBeUndefined()
  })

  it('has no hash for a file that is not there', async () => {
    expect(await movieHash('/gone.mkv', { stat: async () => undefined, readRange: async () => new Uint8Array() })).toBeUndefined()
  })
})
