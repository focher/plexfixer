/**
 * Whether a subtitle is in step with the audio, and by how much it is not.
 *
 * The question a person actually asks is "do these subtitles match this film",
 * and there is no metadata anywhere that answers it. What there is, is two
 * timelines: when somebody is speaking, and when a line of text is on screen.
 * If the subtitle belongs to this cut of this film, those two line up. If it
 * was timed against a different release, they line up after a shift. If it was
 * timed against a broadcast transfer at a different frame rate, they only line
 * up after a shift *and* a stretch — and that case is the one a human notices
 * last, because the first ten minutes look fine and the last ten are a minute
 * out.
 *
 * So this measures all three: how well they agree as they stand, the shift
 * that agrees best, and whether the whole timeline needs stretching as well as
 * moving. The stretch is found by trying each of the frame rate conversions
 * that actually happen and seeing which one lines up, rather than by comparing
 * the beginning of the film against the end — which was the first design here
 * and does not work. A subtitle that drifts by a minute drifts by fifteen
 * seconds within any quarter of the film too, and fifteen seconds of smear
 * across lines three seconds long leaves no peak to find. Stretching first and
 * correlating afterwards puts the peak back.
 *
 * Nothing here reads a file or runs a process. It is handed the speech
 * intervals and the cues and does arithmetic, which is what makes it testable
 * against timelines built by hand.
 */

import { FRAME_RATE_RATIOS, scaleCues, shiftCues, type Cue } from './cues.js'
import type { SpeechInterval } from './silence.js'

/* ------------------------------------------------------------------ *
 * Timelines
 * ------------------------------------------------------------------ */

/**
 * Three passes, each narrower and finer than the last.
 *
 * The sweep is run once per candidate frame rate ratio over the whole search
 * range, so it is the one that has to be cheap: half-second buckets over a
 * two-hour film is 14,400 of them, and nine ratios across four minutes of
 * candidate shifts comes to about sixty million comparisons — a fraction of a
 * second. The two passes after it look only where the sweep pointed, so they
 * can afford to be forty times finer.
 */
const SWEEP_MS = 500
const COARSE_MS = 250
/** Fine pass: a quarter of a frame at 24 fps, which is past the point of noticing. */
const FINE_MS = 25
/** How far out of step a subtitle can be and still be the right subtitle. */
const MAX_SHIFT_MS = 120_000
/** How far each pass looks either side of where the one before it pointed. */
const COARSE_WINDOW_MS = 1500
const FINE_WINDOW_MS = 400
/**
 * How much better a stretch has to look before it is believed.
 *
 * Without this, a subtitle that is already right gets told to stretch itself by
 * a tenth of a percent because one of the ratios happened to score a hair
 * higher on noise. Doing nothing is the default and has to be beaten clearly,
 * not narrowly.
 */
const STRETCH_MARGIN = 0.05
/**
 * How well a stretched alignment has to end up fitting before it is believed.
 *
 * The sweep tries nine ratios across a few thousand candidate shifts each, and
 * the best of twenty thousand tries at fitting noise beats the best of two
 * thousand often enough to matter — which is how a subtitle belonging to
 * another film entirely came to be reported as this one with a 4% stretch. So a
 * stretch has to earn itself twice: once by beating no-stretch in the sweep,
 * and again by the finished alignment actually being a decent fit. A stretch
 * that only ever reaches a poor fit was fitting the noise, and is dropped.
 */
const STRETCH_NEEDS_SCORE = 0.2

/**
 * A film's timeline as one byte per bucket, 1 where the thing is happening.
 *
 * A bit array would be four times smaller and considerably more fiddly to read;
 * a two-hour film at 250 ms is 28,800 bytes, which is not worth the cleverness.
 */
function paint(spans: readonly { startMs: number; endMs: number }[], bucketMs: number, buckets: number): Uint8Array {
  const line = new Uint8Array(buckets)
  for (const span of spans) {
    const from = Math.max(0, Math.floor(span.startMs / bucketMs))
    const to = Math.min(buckets - 1, Math.ceil(span.endMs / bucketMs))
    for (let index = from; index <= to; index++) line[index] = 1
  }
  return line
}

/* ------------------------------------------------------------------ *
 * Agreement
 * ------------------------------------------------------------------ */

/**
 * How much the two timelines agree, corrected for how full each of them is.
 *
 * Plain overlap is no use as a score: speech covers more than half of a film
 * and cues cover a third, so two timelines with nothing whatever to do with
 * each other still overlap about a fifth of the time, and a number that reads
 * 0.46 for noise tells nobody anything. This is the correlation coefficient of
 * the two, which is zero for timelines that are unrelated however full they
 * are, and rises from there.
 *
 * It does not reach one even for a perfect match, and cannot: a subtitle is
 * silent during music, so the speech timeline is always the larger of the two.
 * A genuinely well-matched subtitle lands between 0.3 and 0.6.
 */
function agreement(overlap: number, speechOn: number, cuesOn: number, buckets: number): number {
  if (buckets === 0 || speechOn === 0 || cuesOn === 0) return 0
  if (speechOn === buckets || cuesOn === buckets) return 0
  const p = speechOn / buckets
  const q = cuesOn / buckets
  const o = overlap / buckets
  const spread = Math.sqrt(p * (1 - p) * q * (1 - q))
  return spread === 0 ? 0 : (o - p * q) / spread
}

/**
 * Running totals, so "how many ones between here and there" costs nothing.
 *
 * Every comparison below is over a window — a quarter of the film, or the part
 * of the film a shifted cue line still covers — and the correlation has to be
 * normalised against how full each timeline is *within that window*. Counting
 * that afresh for every one of a thousand candidate shifts is the whole cost of
 * the search; counting it once into a prefix sum makes it a subtraction.
 */
function prefixSums(line: Uint8Array): Int32Array {
  const sums = new Int32Array(line.length + 1)
  for (let index = 0; index < line.length; index++) sums[index + 1] = sums[index] + line[index]
  return sums
}

interface Peak {
  /** Shift in milliseconds; positive means the subtitle should happen later. */
  offsetMs: number
  score: number
  /** The best score anywhere more than two seconds from the peak. */
  runnerUp: number
}

/**
 * The shift that agrees best, and how much better it is than everything else.
 *
 * The runner-up matters as much as the peak. A correct alignment is a spike:
 * move it half a second either way and the score falls off, because dialogue
 * starts and stops on a scale of seconds. A wrong one is a plateau — it scores
 * the same at any lag, because all it is measuring is that both timelines are
 * busy. The gap between the peak and the best score well away from it is what
 * tells those two apart, and it is the only thing here that does.
 *
 * `cues` may be a slice of the cue timeline rather than all of it, which is how
 * the beginning and the end of a film are measured separately. So `scope` names
 * the stretch of film a search is about: a third of the cues judged against the
 * density of the whole film would read as a third as dense, and the margin that
 * decides whether the peak is real would be measured on the wrong scale.
 *
 * Within that scope the normalisation is a constant — it has to be. The two
 * earlier attempts here both made the divisor depend on the candidate shift, by
 * measuring density over whatever the two lines happened to have in common at
 * each one. That makes the score change from one candidate to the next even
 * where the overlap is identical, so a run of genuinely equal shifts stops
 * being equal and the best of them turns out to be whichever one the divisor
 * flattered. The second attempt, which fixed the window at the nominal shift,
 * went wrong in a subtler way: the window cuts off the start of the film, and a
 * cue sitting near that cut is counted more fully at some shifts than at
 * others. Both leaned the answer towards one end of the run — a six second
 * offset came back as 6.375.
 *
 * So: the divisor is fixed, and the overlap is counted over everything the two
 * lines have in common at that shift, with the cue line always read from its
 * own beginning. The same cue content is compared at every candidate, against
 * speech moved underneath it, which is what a cross-correlation is and what
 * this should have been from the start.
 */
function search(
  speech: Uint8Array,
  cues: Uint8Array,
  bucketMs: number,
  centreMs: number,
  rangeMs: number,
  scope?: { from: number; to: number }
): Peak {
  const centre = Math.round(centreMs / bucketMs)
  const reach = Math.max(1, Math.round(rangeMs / bucketMs))

  const scopeFrom = scope?.from ?? 0
  const scopeTo = scope?.to ?? speech.length
  const width = scopeTo - scopeFrom
  if (width <= 0) return { offsetMs: centreMs, score: 0, runnerUp: 0 }

  const speechSums = prefixSums(speech)
  const speechOn = speechSums[scopeTo] - speechSums[scopeFrom]
  const cueSums = prefixSums(cues)
  const cuesOn = cueSums[cues.length]

  let bestLag = centre
  let best = -Infinity
  const scores: { lag: number; score: number }[] = []

  for (let lag = centre - reach; lag <= centre + reach; lag++) {
    const from = Math.max(scopeFrom, lag)
    const to = Math.min(scopeTo, cues.length + lag)
    let overlap = 0
    for (let index = from; index < to; index++) overlap += speech[index] & cues[index - lag]
    scores.push({ lag, score: agreement(overlap, speechOn, cuesOn, width) })
    if (scores[scores.length - 1].score > best) {
      best = scores[scores.length - 1].score
      bestLag = lag
    }
  }

  // A cue sits inside a stretch of speech with a little room either side, so
  // there is usually not one best shift but a short run of equally good ones.
  // The middle of that run is the answer: it is the shift furthest from being
  // wrong in either direction, where taking the first or the last would lean
  // the result half the run's width off in whichever direction the loop
  // happened to go.
  let low = bestLag
  let high = bestLag
  const index = (lag: number): number => lag - (centre - reach)
  while (low > centre - reach && scores[index(low - 1)].score >= best) low--
  while (high < centre + reach && scores[index(high + 1)].score >= best) high++
  bestLag = Math.round((low + high) / 2)

  // Two seconds, because that is roughly the length of a line of dialogue: a
  // peak that is still the peak a line away is not a peak.
  const apart = Math.max(1, Math.round(2000 / bucketMs))
  let runnerUp = -Infinity
  for (const entry of scores) {
    if (Math.abs(entry.lag - bestLag) <= apart) continue
    if (entry.score > runnerUp) runnerUp = entry.score
  }

  return {
    offsetMs: bestLag * bucketMs,
    score: best === -Infinity ? 0 : best,
    runnerUp: runnerUp === -Infinity ? 0 : runnerUp
  }
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/** How much to trust the answer, which is a separate question from what it is. */
export type SyncConfidence = 'good' | 'fair' | 'poor'

export type SyncState =
  /** Close enough that nobody would notice. */
  | 'in-sync'
  /** A constant shift fixes it. */
  | 'offset'
  /** It drifts: the timeline needs stretching as well as moving. */
  | 'drifting'
  /** The two timelines have nothing to say to each other. */
  | 'mismatched'
  /** There was not enough to work with — no cues, no speech, or too short. */
  | 'unknown'

export interface SyncReport {
  state: SyncState
  confidence: SyncConfidence
  /**
   * The shift to apply, in milliseconds, *after* any stretch.
   *
   * Positive means the subtitle happens too early and should be moved later.
   * Applying the report means `scaleCues` by `factor` and then `shiftCues` by
   * this, in that order — which is what `applySync` does.
   */
  offsetMs: number
  /** The timeline stretch; 1 when none is needed. */
  factor: number
  /** What that stretch is, in frame rates, when it is one of the usual ones. */
  factorLabel?: string
  /** Correlation at the alignment this report recommends. */
  score: number
  /** Correlation at the subtitle's timing as it stands, for comparison. */
  scoreAsIs: number
  /** How far the peak stands above the rest of the search. */
  margin: number
  /**
   * The share of cues that begin while somebody is speaking, once the report
   * is applied.
   *
   * The legible number, for a person reading the panel — it is what somebody
   * would count by hand. It is *not* the number that decides anything, and it
   * must not be read as one: on a talkative film where three quarters of the
   * running time has speech under it, a subtitle picked at random still scores
   * around three quarters. The correlation above is the measure with a
   * meaningful zero, which is why the verdict comes from that. `speechShare`
   * is carried alongside so the baseline is visible rather than implied.
   */
  cueHitRate: number
  cueHitRateAsIs: number
  /**
   * The share of the film that has sound in it.
   *
   * The baseline for the two rates above: a subtitle scattered at random over a
   * film scores roughly this. A hit rate that is not well clear of it says
   * nothing, however high the number looks.
   */
  speechShare: number
  /** One sentence, for the panel. */
  summary: string
}

/**
 * The share of cues that begin while somebody is speaking.
 *
 * The cue's *start* has to land in a stretch of speech, not merely overlap one
 * somewhere along its length. The looser version credited a line for brushing
 * past any sound in the film, which on a busy soundtrack is nearly every line
 * wherever you put it, and a measure that reads 99% for a subtitle belonging to
 * another film is worse than no measure at all.
 *
 * The tolerance is for the convention of putting a line up a fraction before
 * the words: without it a correctly timed subtitle marks itself wrong.
 */
export function cueHitRate(cues: readonly Cue[], speech: readonly SpeechInterval[], toleranceMs = 400): number {
  if (cues.length === 0 || speech.length === 0) return 0
  const sorted = [...speech].sort((a, b) => a.startMs - b.startMs)
  let hits = 0

  for (const cue of cues) {
    let low = 0
    let high = sorted.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const span = sorted[middle]
      if (span.endMs < cue.startMs) low = middle + 1
      else if (span.startMs - toleranceMs > cue.startMs) high = middle - 1
      else {
        hits++
        break
      }
    }
  }

  return hits / cues.length
}

/** The known frame rate ratio this measured stretch is, when it is one. */
function namedRatio(factor: number): { factor: number; label: string } | undefined {
  let closest: { factor: number; label: string } | undefined
  let distance = Infinity
  for (const ratio of FRAME_RATE_RATIOS) {
    const apart = Math.abs(ratio.factor - factor)
    if (apart < distance) {
      distance = apart
      closest = ratio
    }
  }
  // Within a third of a percent: over two hours that is twenty-four seconds of
  // difference, so anything closer than this is the named ratio and anything
  // further is genuinely something else.
  return closest && distance <= 0.003 ? closest : undefined
}

function describe(report: Omit<SyncReport, 'summary'>): string {
  const seconds = (ms: number): string => `${(Math.abs(ms) / 1000).toFixed(ms % 1000 === 0 ? 0 : 2)}s`

  switch (report.state) {
    case 'unknown':
      return 'There was not enough here to compare — either the subtitle has no lines or the audio has no speech in it.'
    case 'mismatched':
      return (
        'These lines do not follow this audio at any offset. It is most likely a subtitle for a different ' +
        'film, a different cut, or a different episode.'
      )
    case 'in-sync':
      return (
        `In step with the audio. ${Math.round(report.cueHitRateAsIs * 100)}% of lines begin while somebody is ` +
        `speaking, against ${Math.round(report.speechShare * 100)}% for lines placed at random.`
      )
    case 'offset':
      return (
        `The lines run ${report.offsetMs > 0 ? 'early' : 'late'} by ${seconds(report.offsetMs)} throughout. ` +
        `Shifting them ${report.offsetMs > 0 ? 'later' : 'earlier'} takes the lines that begin on speech from ` +
        `${Math.round(report.cueHitRateAsIs * 100)}% to ${Math.round(report.cueHitRate * 100)}%.`
      )
    case 'drifting':
      return (
        `The lines drift out of step as the film goes on${report.factorLabel ? ` — this is ${report.factorLabel}` : ''}. ` +
        `Stretching the timeline by ${((report.factor - 1) * 100).toFixed(2)}% and shifting it ` +
        `${report.offsetMs >= 0 ? 'later' : 'earlier'} by ${seconds(report.offsetMs)} takes the lines that begin ` +
        `on speech from ${Math.round(report.cueHitRateAsIs * 100)}% to ${Math.round(report.cueHitRate * 100)}%.`
      )
  }
}

/* ------------------------------------------------------------------ *
 * The measurement
 * ------------------------------------------------------------------ */

/** Anything closer than this is not worth telling anyone about. */
export const IN_SYNC_TOLERANCE_MS = 250

export interface SyncOptions {
  /** How far out of step to look, in milliseconds. */
  maxShiftMs?: number
  /** Treat anything within this as already in step. */
  toleranceMs?: number
}

/**
 * Compare a subtitle against the speech in a film.
 *
 * Three passes, each looking only where the one before it pointed:
 *
 * 1. **Sweep.** For each frame rate conversion worth considering, stretch the
 *    cue timeline by that ratio and find the shift that agrees best. The ratio
 *    whose best shift scores highest is the hypothesis — and no stretch has to
 *    beat doing nothing by a clear margin before it is believed.
 * 2. **Coarse.** Re-find that shift at a quarter-second, within a second and a
 *    half of where the sweep put it.
 * 3. **Fine.** Settle it to twenty-five milliseconds, which is past the point
 *    where anybody can see the difference.
 *
 * Then, with the transform applied, the first and last thirds are checked
 * against each other for whatever drift is *left*. That check is safe here and
 * was not before: a residual of a second or two does not smear a correlation
 * the way the original minute did, so the peaks it needs are there to be found.
 * It is what catches a retiming that is not any standard frame rate ratio.
 */
export function analyseSync(
  cues: readonly Cue[],
  speech: readonly SpeechInterval[],
  durationSeconds: number,
  options: SyncOptions = {}
): SyncReport {
  const maxShiftMs = options.maxShiftMs ?? MAX_SHIFT_MS
  const tolerance = options.toleranceMs ?? IN_SYNC_TOLERANCE_MS
  const durationMs = Math.round(durationSeconds * 1000)

  let sounding = 0
  for (const span of speech) sounding += Math.max(0, span.endMs - span.startMs)
  const speechShare = durationMs > 0 ? Math.min(1, sounding / durationMs) : 0

  const nothingToSay = (state: SyncState): SyncReport => {
    const base = {
      state,
      confidence: 'poor' as const,
      offsetMs: 0,
      factor: 1,
      score: 0,
      scoreAsIs: 0,
      margin: 0,
      cueHitRate: 0,
      cueHitRateAsIs: 0,
      speechShare
    }
    return { ...base, summary: describe(base) }
  }

  // Under two minutes there is not enough dialogue for a correlation to mean
  // anything: a handful of lines will align convincingly with almost anything.
  if (cues.length < 5 || speech.length === 0 || durationMs < 120_000) return nothingToSay('unknown')

  /* --- 1. which stretch, if any --- */

  const sweepBuckets = Math.ceil(durationMs / SWEEP_MS) + 1
  const speechSweep = paint(speech, SWEEP_MS, sweepBuckets)

  let best: { factor: number; label?: string; peak: Peak } | undefined
  let noStretch: Peak | undefined

  for (const ratio of FRAME_RATE_RATIOS) {
    const candidate = ratio.factor === 1 ? cues : scaleCues(cues, ratio.factor, 0)
    const peak = search(speechSweep, paint(candidate, SWEEP_MS, sweepBuckets), SWEEP_MS, 0, maxShiftMs)
    if (ratio.factor === 1) noStretch = peak
    // A stretch must clear doing nothing by a real margin. `noStretch` is
    // always set by the time any other ratio is reached, because the identity
    // is first in the table.
    const bar = ratio.factor === 1 ? -Infinity : (noStretch?.score ?? -Infinity) + STRETCH_MARGIN
    if (peak.score > (best?.peak.score ?? -Infinity) && peak.score > bar) {
      best = { factor: ratio.factor, label: ratio.factor === 1 ? undefined : ratio.label, peak }
    }
  }

  const hypothesis = best ?? { factor: 1, label: undefined, peak: noStretch as Peak }
  let factor = hypothesis.factor
  let factorLabel = hypothesis.label

  /* --- 2 and 3. where exactly --- */

  const coarseBuckets = Math.ceil(durationMs / COARSE_MS) + 1
  const speechCoarse = paint(speech, COARSE_MS, coarseBuckets)
  const fineBuckets = Math.ceil(durationMs / FINE_MS) + 1
  const speechFine = paint(speech, FINE_MS, fineBuckets)

  /** Lock a stretched timeline down to the nearest twenty-five milliseconds. */
  const settle = (stretched: readonly Cue[], aroundMs: number): Peak => {
    const coarse = search(
      speechCoarse,
      paint(stretched, COARSE_MS, coarseBuckets),
      COARSE_MS,
      aroundMs,
      COARSE_WINDOW_MS
    )
    return search(speechFine, paint(stretched, FINE_MS, fineBuckets), FINE_MS, coarse.offsetMs, FINE_WINDOW_MS)
  }

  let stretched = factor === 1 ? [...cues] : scaleCues(cues, factor, 0)
  let fine = settle(stretched, hypothesis.peak.offsetMs)

  /* --- 4. whatever drift is left over --- */

  // Only worth asking once the alignment is good enough for the answer to mean
  // something; on a mismatched subtitle this would be measuring noise against
  // noise.
  if (fine.score >= 0.15) {
    const aligned = shiftCues(stretched, fine.offsetMs)
    const third = Math.floor(fineBuckets / 3)
    const cueFine = paint(aligned, FINE_MS, fineBuckets)
    // Each third is correlated where it sits, within two seconds — which is all
    // the room a residual needs, and little enough that nothing can wander off
    // and find a different line to agree with.
    const earlyPeak = search(speechFine, cueFine.subarray(0, third), FINE_MS, 0, 2000, { from: 0, to: third })
    const latePeak = search(
      speechFine,
      cueFine.subarray(fineBuckets - third),
      FINE_MS,
      (fineBuckets - third) * FINE_MS,
      2000,
      { from: fineBuckets - third, to: fineBuckets }
    )
    const lateResidual = latePeak.offsetMs - (fineBuckets - third) * FINE_MS
    const span = (fineBuckets - third / 2) * FINE_MS - (third / 2) * FINE_MS

    const bothLandedWell = earlyPeak.score - earlyPeak.runnerUp > 0.02 && latePeak.score - latePeak.runnerUp > 0.02
    // Each end is measured from a third of the lines, and the best shift for a
    // third of the lines wobbles by a few hundred milliseconds depending on
    // which lines they are. Two seconds between the ends is past that wobble
    // and still far below what anyone would notice, so nothing real is given up
    // by insisting on it — and without it, every correctly timed subtitle in
    // the world gets told to stretch itself by a tenth of a percent.
    const RESIDUAL_FLOOR_MS = 2000
    if (bothLandedWell && span > 0 && Math.abs(lateResidual - earlyPeak.offsetMs) > RESIDUAL_FLOOR_MS) {
      const residualFactor = 1 + (lateResidual - earlyPeak.offsetMs) / span
      const combined = factor * residualFactor
      // Below two parts in a thousand there is nothing to tell anybody: over a
      // two-hour film that is fourteen seconds end to end at the very most, and
      // "stretch this by 0.1%" is not advice a person can act on.
      if (combined > 0.94 && combined < 1.06 && Math.abs(combined - 1) > 0.002) {
        const named = namedRatio(combined)
        factor = named ? named.factor : combined
        factorLabel = named?.label
        stretched = factor === 1 ? [...cues] : scaleCues(cues, factor, 0)
        fine = settle(stretched, fine.offsetMs)
      }
    }
  }

  // A stretch that never got the alignment anywhere was fitting noise. Drop it
  // and measure again unstretched, so what comes out is either a plain offset
  // or an honest refusal rather than invented advice.
  if (Math.abs(factor - 1) > 0.0005 && fine.score < STRETCH_NEEDS_SCORE) {
    factor = 1
    factorLabel = undefined
    stretched = [...cues]
    fine = settle(stretched, noStretch?.offsetMs ?? 0)
  }

  /* --- the verdict --- */

  const asIs = search(speechFine, paint(cues, FINE_MS, fineBuckets), FINE_MS, 0, 0)
  const aligned = shiftCues(stretched, fine.offsetMs)

  const margin = fine.score - Math.max(hypothesis.peak.runnerUp, fine.runnerUp)
  const confidence: SyncConfidence =
    fine.score >= 0.3 && margin >= 0.08 ? 'good' : fine.score >= 0.15 && margin >= 0.03 ? 'fair' : 'poor'

  let state: SyncState
  if (fine.score < 0.1 || margin < 0.02) state = 'mismatched'
  else if (Math.abs(factor - 1) > 0.0005) state = 'drifting'
  else if (Math.abs(fine.offsetMs) <= tolerance) state = 'in-sync'
  else state = 'offset'

  const base = {
    state,
    confidence,
    offsetMs: state === 'in-sync' || state === 'mismatched' ? 0 : fine.offsetMs,
    factor: state === 'mismatched' ? 1 : factor,
    factorLabel: state === 'drifting' ? factorLabel : undefined,
    score: fine.score,
    scoreAsIs: asIs.score,
    margin,
    cueHitRate: cueHitRate(aligned, speech),
    cueHitRateAsIs: cueHitRate(cues, speech),
    speechShare
  }

  return { ...base, summary: describe(base) }
}

/**
 * The cues as the report says they should be: stretched, then shifted.
 *
 * The order is not interchangeable. A stretch is about the origin, so applying
 * it after a shift would stretch the shift too and land somewhere else
 * entirely.
 */
export function applySync(cues: readonly Cue[], report: SyncReport): Cue[] {
  const stretched = report.factor === 1 ? [...cues] : scaleCues(cues, report.factor, 0)
  return report.offsetMs === 0 ? stretched : shiftCues(stretched, report.offsetMs)
}
