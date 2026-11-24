/**
 * Where the talking is, worked out from where the silence is not.
 *
 * Deciding whether a subtitle is in step with the audio needs to know when
 * somebody is speaking, and getting that normally means a voice activity model.
 * ffmpeg already ships one good enough for the job: `silencedetect` reports
 * every stretch quieter than a threshold, and the gaps between those stretches
 * are, near enough, the dialogue.
 *
 * "Near enough" is doing real work in that sentence — music and effects are
 * loud too, so this over-reports speech rather than under-reports it. That is
 * the right direction to be wrong in. The comparison downstream asks how well
 * the cues sit *inside* the loud parts, and extra loud parts only weaken a
 * match; extra silence would break one.
 */

/** A stretch of the film with sound in it, in milliseconds. */
export interface SpeechInterval {
  startMs: number
  endMs: number
}

/**
 * The filter, with the thresholds chosen for dialogue rather than for noise.
 *
 * -32 dB is low enough to keep quiet speech and room tone apart on a film
 * mixed with real headroom, and high enough not to call tape hiss dialogue.
 * Half a second is about the shortest gap between sentences that means
 * anything — shorter than that and ordinary pauses between words start
 * chopping one line into four.
 */
export const SILENCE_FILTER = 'silencedetect=noise=-32dB:d=0.5'

/** ffmpeg prints these to stderr, one per line, as it goes. */
const SILENCE_START = /silence_start:\s*(-?[\d.]+)/
const SILENCE_END = /silence_end:\s*(-?[\d.]+)/

/**
 * Turn `silencedetect` output into the intervals that are *not* silent.
 *
 * The filter reports silence, so this is an inversion: the film runs from zero
 * to `durationSeconds`, each reported silence is cut out of it, and what is
 * left is sound. A silence that is still open when the file ends — which is
 * ordinary, since films end quiet — closes at the end.
 */
export function speechIntervals(stderr: string, durationSeconds: number): SpeechInterval[] {
  const durationMs = Math.max(0, Math.round(durationSeconds * 1000))
  const silences: SpeechInterval[] = []
  let openedAt: number | undefined

  for (const line of stderr.split('\n')) {
    const start = SILENCE_START.exec(line)
    if (start) {
      // ffmpeg can report a start at a slightly negative time on the first
      // block; the film does not begin before itself.
      openedAt = Math.max(0, Math.round(Number(start[1]) * 1000))
      continue
    }
    const end = SILENCE_END.exec(line)
    if (end && openedAt !== undefined) {
      const closedAt = Math.max(openedAt, Math.round(Number(end[1]) * 1000))
      silences.push({ startMs: openedAt, endMs: closedAt })
      openedAt = undefined
    }
  }
  if (openedAt !== undefined && durationMs > openedAt) {
    silences.push({ startMs: openedAt, endMs: durationMs })
  }

  const speech: SpeechInterval[] = []
  let cursor = 0
  for (const silence of silences.sort((a, b) => a.startMs - b.startMs)) {
    if (silence.startMs > cursor) speech.push({ startMs: cursor, endMs: silence.startMs })
    cursor = Math.max(cursor, silence.endMs)
  }
  if (durationMs > cursor) speech.push({ startMs: cursor, endMs: durationMs })

  return speech
}

/** How much of the film has sound in it, as a fraction. */
export function speechFraction(intervals: readonly SpeechInterval[], durationSeconds: number): number {
  const durationMs = durationSeconds * 1000
  if (durationMs <= 0) return 0
  let total = 0
  for (const interval of intervals) total += Math.max(0, interval.endMs - interval.startMs)
  return Math.min(1, total / durationMs)
}
