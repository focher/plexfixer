/**
 * When moving the MP4 index is the whole repair.
 *
 * ffmpeg's `+faststart` is a remux followed by a second pass over the whole
 * output to shift the media data down behind the index. `qt-faststart` does
 * the same move in one read and one write, patching the chunk offsets as it
 * goes — but it can do nothing else. It is used only when nothing else in the
 * plan would change the file.
 */

import type { AnalysisResult, MediaFile } from '../types.js'
import { videoStreams } from './tracks.js'

export function isIndexMoveOnly(result: AnalysisResult): boolean {
  const { plan, file } = result
  if (file.container !== 'mp4' || plan.targetContainer !== 'mp4') return false
  if (plan.strategy !== 'remux' || file.faststart !== false) return false
  if (plan.videoTranscode || plan.requiresTranscode) return false
  if (plan.addCompatibilityAudio || plan.resyncSubtitles.length > 0) return false
  if (plan.videoLevel != null) return false
  if (plan.trackChanges.length > 0) return false

  // The plan carries the tag the output should have, which is usually the one
  // the file already has; only a real change rules this out.
  if (plan.videoCodecTag) {
    const current = videoStreams(file)[0]?.codecTag
    if ((current ?? '').toLowerCase() !== plan.videoCodecTag.toLowerCase()) return false
  }
  return true
}

/**
 * Why a file that only had its index moved does not match its source, or
 * `undefined` when it does. The move changes no stream, so the same streams of
 * the same kinds and codecs, and the same duration, are expected back — with
 * the index now at the front.
 */
export function indexMoveMismatch(source: MediaFile, output: MediaFile): string | undefined {
  if (output.faststart !== true) return 'the index is still not at the front of the output'
  const describe = (file: MediaFile): string => file.streams.map((s) => `${s.kind}:${s.codec}`).join(', ')
  if (describe(source) !== describe(output)) {
    return `the output's streams (${describe(output)}) differ from the original's (${describe(source)})`
  }
  if (source.durationSeconds != null && output.durationSeconds != null) {
    if (Math.abs(source.durationSeconds - output.durationSeconds) > 1) {
      return `the output runs ${output.durationSeconds.toFixed(1)}s, the original ${source.durationSeconds.toFixed(1)}s`
    }
  }
  return undefined
}
