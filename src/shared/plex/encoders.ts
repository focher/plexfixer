/**
 * Finding out what an ffmpeg can do, by running it.
 *
 * Being listed is necessary but not sufficient: a build advertises
 * `h264_nvenc` on a machine with no NVIDIA driver and `libplacebo` on one with
 * no Vulkan device, and both fail at open time. How to run it is passed in, so
 * the encoders reported are the ones on the machine that will do the work —
 * which, for a remote host, is the only answer worth having.
 */

import type { EncoderCapabilities } from '../types.js'
import { DOLBY_VISION_HDR10_FILTER } from './rules.js'

/* ------------------------------------------------------------------ *
 * Encoder discovery
 * ------------------------------------------------------------------ */

/** Hardware encoders worth probing for, in rough order of preference. */
const HARDWARE_ENCODERS = [
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'hevc_qsv',
  'h264_amf',
  'hevc_amf',
  'h264_videotoolbox',
  'hevc_videotoolbox',
  'h264_vaapi',
  'hevc_vaapi'
]

/**
 * Ask ffmpeg which encoders it was built with.
 *
 * Being listed is necessary but not sufficient — a build can advertise
 * `h264_nvenc` on a machine with no NVIDIA GPU. `probeEncoderWorks` confirms it
 * by actually encoding a handful of frames.
 */
export interface DetectOptions {
  /**
   * How to run ffmpeg, and so which machine is being asked about.
   */
  exec: (command: string, args: string[]) => Promise<string>
  /** The platform those encoders belong to. */
  platform: string
}

export async function detectEncoders(ffmpegPath: string, options: DetectOptions): Promise<EncoderCapabilities> {
  const exec = options.exec
  let available: string[] = []
  let ffmpegVersion: string | undefined

  try {
    const stdout = await exec(ffmpegPath, ['-hide_banner', '-encoders'])
    available = HARDWARE_ENCODERS.filter((name) => new RegExp(`\\b${name}\\b`).test(stdout))
  } catch {
    available = []
  }

  try {
    const stdout = await exec(ffmpegPath, ['-version'])
    ffmpegVersion = stdout.split('\n', 1)[0]?.trim()
  } catch {
    ffmpegVersion = undefined
  }

  // Confirm NVENC really works; on a machine with no NVIDIA driver the encoder
  // is listed but fails at open time, which would otherwise surface as a
  // mystifying failure on the first real transcode.
  let nvenc = available.some((name) => name.endsWith('_nvenc'))
  if (nvenc) nvenc = await probeEncoderWorks(ffmpegPath, 'h264_nvenc', exec)

  let videotoolbox = available.some((name) => name.endsWith('_videotoolbox'))
  if (videotoolbox) videotoolbox = await probeEncoderWorks(ffmpegPath, 'h264_videotoolbox', exec)

  let qsv = available.some((name) => name.endsWith('_qsv'))
  if (qsv) qsv = await probeEncoderWorks(ffmpegPath, 'h264_qsv', exec)

  let amf = available.some((name) => name.endsWith('_amf'))
  if (amf) amf = await probeEncoderWorks(ffmpegPath, 'h264_amf', exec)

  const libplacebo = await probeLibplaceboWorks(ffmpegPath, exec)

  return {
    platform: options.platform,
    available,
    nvenc,
    videotoolbox,
    qsv,
    amf,
    libplacebo,
    ffmpegVersion
  }
}

/**
 * Run a frame through `libplacebo` to see whether it is really usable.
 *
 * Being built with `--enable-libplacebo` is not enough: the filter runs on
 * Vulkan, so it fails at open time on a machine with no Vulkan driver — which
 * on macOS means no MoltenVK. Those are the same mystifying mid-transcode
 * failure that `probeEncoderWorks` exists to avoid, and the cost of being
 * wrong here is worse: a Dolby Vision file whose colours are silently ruined.
 */
export async function probeLibplaceboWorks(
  ffmpegPath: string,
  exec: (command: string, args: string[]) => Promise<string>
): Promise<boolean> {
  try {
    await exec(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-init_hw_device',
      'vulkan=plexfixer',
      '-filter_hw_device',
      'plexfixer',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=25:duration=0.2',
      '-vf',
      DOLBY_VISION_HDR10_FILTER,
      '-frames:v',
      '2',
      '-f',
      'null',
      '-'
    ])
    return true
  } catch {
    return false
  }
}

/** Encode a few frames of test pattern to confirm an encoder opens on this machine. */
export async function probeEncoderWorks(
  ffmpegPath: string,
  encoder: string,
  exec: (command: string, args: string[]) => Promise<string>
): Promise<boolean> {
  try {
    await exec(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=25:duration=0.2',
        '-c:v',
        encoder,
        '-frames:v',
        '3',
        '-f',
        'null',
        '-'
    ])
    return true
  } catch {
    return false
  }
}
