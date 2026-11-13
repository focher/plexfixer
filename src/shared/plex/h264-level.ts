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

export interface LevelFit {
  fits: boolean
  /** Why not, in a sentence fragment that reads after "the stream …". */
  reason?: string
}

const formatRate = (rate: number): string => (Number.isInteger(rate) ? String(rate) : rate.toFixed(3).replace(/0+$/, ''))

/**
 * Whether a stream valid at `sourceLevel` is also within every limit of
 * `targetLevel`, so its level can be relabelled without re-encoding — and if
 * not, which limit it breaks.
 */
export function h264LevelFit(stream: VideoStream, sourceLevel: number, targetLevel: number): LevelFit {
  const source = H264_LEVEL_LIMITS[sourceLevel]
  const target = H264_LEVEL_LIMITS[targetLevel]
  const label = h264LevelLabel(targetLevel)
  if (!source || !target) return { fits: false, reason: `has a level (${sourceLevel}) this app does not know the limits of` }
  if (stream.isInterlaced) return { fits: false, reason: 'is interlaced, which the level check does not cover' }
  if (!(stream.width > 0) || !(stream.height > 0) || !(stream.frameRate && stream.frameRate > 0)) {
    return { fits: false, reason: 'has a frame size or frame rate that could not be read' }
  }

  const size = `${stream.width}×${stream.height}`
  const widthMbs = Math.ceil(stream.width / 16)
  const heightMbs = Math.ceil(stream.height / 16)
  const frameMbs = widthMbs * heightMbs

  const maxSide = Math.sqrt(8 * target.maxFs)
  if (frameMbs > target.maxFs || widthMbs > maxSide || heightMbs > maxSide) {
    return { fits: false, reason: `is ${size}, a bigger frame than Level ${label} allows` }
  }

  if (frameMbs * stream.frameRate > target.maxMbps) {
    return { fits: false, reason: `is ${size} at ${formatRate(stream.frameRate)} fps, faster than Level ${label} decodes` }
  }

  // The frame buffer holds fewer frames the bigger each one is. The stream's
  // own reference-frame count decides it when the SPS could be read; without
  // it, assume the stream may use everything its current level allows.
  const allowed = maxRefFrames(target, frameMbs)
  if (stream.refFrames != null) {
    if (stream.refFrames > allowed) {
      return {
        fits: false,
        reason: `uses ${stream.refFrames} reference frames, and Level ${label} allows ${allowed} at ${size}`
      }
    }
  } else if (allowed < maxRefFrames(source, frameMbs)) {
    return {
      fits: false,
      reason: `may use up to ${maxRefFrames(source, frameMbs)} reference frames (the count could not be read), and Level ${label} allows ${allowed} at ${size}`
    }
  }

  if (target.maxBrKbps < source.maxBrKbps) {
    if (!(stream.bitRate && stream.bitRate > 0)) {
      return { fits: false, reason: `has no measured bitrate to check against Level ${label}'s ceiling` }
    }
    if (stream.bitRate > target.maxBrKbps * 1000 * 0.8) {
      return { fits: false, reason: `runs at a higher bitrate than Level ${label} allows` }
    }
  }

  return { fits: true }
}

/**
 * True when a stream valid at `sourceLevel` is also within every limit of
 * `targetLevel`, so its level can be relabelled without re-encoding.
 */
export function fitsH264Level(stream: VideoStream, sourceLevel: number, targetLevel: number): boolean {
  return h264LevelFit(stream, sourceLevel, targetLevel).fits
}

/** 41 -> "4.1", the form ffmpeg's h264_metadata filter and people both read. */
export function h264LevelLabel(level: number): string {
  return (level / 10).toFixed(1)
}
