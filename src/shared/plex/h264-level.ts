/**
 * Whether an H.264 stream labelled with one level actually fits a lower one.
 *
 * The level is a promise about the decoder resources a stream needs —
 * macroblocks per second, frame size, reference-frame buffer, bitrate. Encoders
 * often stamp a level far above what the content needs (a 640×480 film marked
 * Level 4.2), and a decoder capped at 4.1 then refuses it. When the stream's
 * real demands fit the lower level, rewriting the label is lossless and
 * correct, and saves a full re-encode.
 *
 * Note the MP4 `avcC` box carries its own copy of the level, which is what
 * tools like Subler display. Players and Plex read the level in the stream's
 * SPS, so that is the one that has to change; ffmpeg's `h264_metadata`
 * bitstream filter rewrites the SPS and the muxer rebuilds `avcC` from it.
 *
 * Deliberately conservative: anything unknown means "does not fit", and the
 * caller falls back to a re-encode.
 */

import type { VideoStream } from '../types.js'

interface LevelLimits {
  /** Max macroblocks per second. */
  maxMbps: number
  /** Max frame size, in macroblocks. */
  maxFs: number
  /** Max decoded picture buffer, in macroblocks. */
  maxDpbMbs: number
  /** Max video bitrate for Baseline/Main, kbit/s (High allows 1.25×; not relied on). */
  maxBrKbps: number
}

/** H.264 Table A-1, keyed by level_idc (41 = Level 4.1). */
export const H264_LEVEL_LIMITS: Record<number, LevelLimits> = {
  10: { maxMbps: 1485, maxFs: 99, maxDpbMbs: 396, maxBrKbps: 64 },
  11: { maxMbps: 3000, maxFs: 396, maxDpbMbs: 900, maxBrKbps: 192 },
  12: { maxMbps: 6000, maxFs: 396, maxDpbMbs: 2376, maxBrKbps: 384 },
  13: { maxMbps: 11880, maxFs: 396, maxDpbMbs: 2376, maxBrKbps: 768 },
  20: { maxMbps: 11880, maxFs: 396, maxDpbMbs: 2376, maxBrKbps: 2000 },
  21: { maxMbps: 19800, maxFs: 792, maxDpbMbs: 4752, maxBrKbps: 4000 },
  22: { maxMbps: 20250, maxFs: 1620, maxDpbMbs: 8100, maxBrKbps: 4000 },
  30: { maxMbps: 40500, maxFs: 1620, maxDpbMbs: 8100, maxBrKbps: 10000 },
  31: { maxMbps: 108000, maxFs: 3600, maxDpbMbs: 18000, maxBrKbps: 14000 },
  32: { maxMbps: 216000, maxFs: 5120, maxDpbMbs: 20480, maxBrKbps: 20000 },
  40: { maxMbps: 245760, maxFs: 8192, maxDpbMbs: 32768, maxBrKbps: 20000 },
  41: { maxMbps: 245760, maxFs: 8192, maxDpbMbs: 32768, maxBrKbps: 50000 },
  42: { maxMbps: 522240, maxFs: 8704, maxDpbMbs: 34816, maxBrKbps: 50000 },
  50: { maxMbps: 589824, maxFs: 22080, maxDpbMbs: 110400, maxBrKbps: 135000 },
  51: { maxMbps: 983040, maxFs: 36864, maxDpbMbs: 184320, maxBrKbps: 240000 },
  52: { maxMbps: 2073600, maxFs: 36864, maxDpbMbs: 184320, maxBrKbps: 240000 },
  60: { maxMbps: 4177920, maxFs: 139264, maxDpbMbs: 696320, maxBrKbps: 240000 },
  61: { maxMbps: 8355840, maxFs: 139264, maxDpbMbs: 696320, maxBrKbps: 480000 },
  62: { maxMbps: 16711680, maxFs: 139264, maxDpbMbs: 696320, maxBrKbps: 800000 }
}

/** Most reference frames the DPB can hold at this frame size (the spec caps it at 16). */
function maxRefFrames(limits: LevelLimits, frameMbs: number): number {
  return Math.min(16, Math.floor(limits.maxDpbMbs / frameMbs))
}

/**
 * True when a stream valid at `sourceLevel` is also within every limit of
 * `targetLevel`, so its level can be relabelled without re-encoding.
 */
export function fitsH264Level(stream: VideoStream, sourceLevel: number, targetLevel: number): boolean {
  const source = H264_LEVEL_LIMITS[sourceLevel]
  const target = H264_LEVEL_LIMITS[targetLevel]
  if (!source || !target) return false
  // Interlaced coding counts macroblocks differently; leave it to a re-encode.
  if (stream.isInterlaced) return false
  if (!(stream.width > 0) || !(stream.height > 0) || !(stream.frameRate && stream.frameRate > 0)) return false

  const widthMbs = Math.ceil(stream.width / 16)
  const heightMbs = Math.ceil(stream.height / 16)
  const frameMbs = widthMbs * heightMbs

  // Frame size, including the spec's limit on either dimension alone.
  const maxSide = Math.sqrt(8 * target.maxFs)
  if (frameMbs > target.maxFs || widthMbs > maxSide || heightMbs > maxSide) return false

  // Throughput.
  if (frameMbs * stream.frameRate > target.maxMbps) return false

  // Reference frames: an encoder conforming to the source level may have used
  // as many as the source allowed at this size; the target must allow as many.
  if (maxRefFrames(target, frameMbs) < maxRefFrames(source, frameMbs)) return false

  // Bitrate: fine if the ceiling does not drop; otherwise the measured rate
  // has to sit well under the new one, since an average hides the peaks.
  if (target.maxBrKbps < source.maxBrKbps) {
    if (!(stream.bitRate && stream.bitRate > 0)) return false
    if (stream.bitRate > target.maxBrKbps * 1000 * 0.8) return false
  }

  return true
}

/** 41 -> "4.1", the form ffmpeg's h264_metadata filter and people both read. */
export function h264LevelLabel(level: number): string {
  return (level / 10).toFixed(1)
}
