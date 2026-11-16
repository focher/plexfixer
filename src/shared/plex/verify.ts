/**
 * Deciding whether a repaired file is fit to replace the original.
 *
 * ffmpeg can exit 0 having written something that is not the file it was
 * asked for, and once the output is promoted the original is in a backup
 * folder at best. So the output is probed and held against the source before
 * anything is moved — and what is checked is what a broken run actually gets
 * wrong: a stream that is not there, or a file that stops early.
 */

import type { MediaFile } from '../types.js'

/**
 * How much shorter than its source a repaired file may be.
 *
 * A remux is not exact: containers round differently, a trailing subtitle can
 * have been what set the source's length, and dropping a track moves the end
 * by a frame or two. A tenth is far outside any of that and far inside what a
 * write that stopped early looks like.
 */
const SHORTEST_ACCEPTABLE = 0.9

/** Below this a tenth is a few seconds, and rounding alone could cross it. */
const TOO_SHORT_TO_JUDGE_SECONDS = 60

function clock(seconds: number): string {
  const whole = Math.round(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

/**
 * Why this output must not replace its source, or `undefined` if it may.
 *
 * Every refusal leaves the original where it is, so being wrong here costs a
 * repair that did not happen; being wrong the other way costs the file.
 */
export function outputProblem(source: MediaFile, output: MediaFile): string | undefined {
  const has = (file: MediaFile, kind: 'video' | 'audio'): boolean => file.streams.some((stream) => stream.kind === kind)

  if (!has(output, 'video') || (has(source, 'audio') && !has(output, 'audio'))) {
    return 'The repaired file is missing streams — the original has been left untouched.'
  }

  const before = source.durationSeconds
  const after = output.durationSeconds
  if (
    before != null &&
    after != null &&
    before >= TOO_SHORT_TO_JUDGE_SECONDS &&
    after < before * SHORTEST_ACCEPTABLE
  ) {
    return (
      `The repaired file runs ${clock(after)} and the original ${clock(before)}, so it stops early — ` +
      'the original has been left untouched.'
    )
  }

  return undefined
}
