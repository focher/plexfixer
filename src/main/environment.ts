/**
 * Resolving the ffmpeg toolchain and the machine's encoder capabilities once,
 * then caching it for the session.
 */

import type { AppSettings, EnvironmentInfo } from '@shared/types.js'
import { binaryVersion, locateBinary } from './ffmpeg/locate.js'
import { detectEncoders } from './ffmpeg/run.js'

export type Environment = EnvironmentInfo

let cached: Environment | undefined
let cachedKey = ''

/**
 * Detection runs a handful of short test encodes, so it is cached against the
 * settings that affect it and only redone when those change.
 */
export async function resolveEnvironment(settings: AppSettings, force = false): Promise<Environment> {
  const key = `${settings.ffmpegPath}|${settings.ffprobePath}`
  if (!force && cached && cachedKey === key) return cached

  const ffmpeg = locateBinary('ffmpeg', settings.ffmpegPath || undefined)
  const ffprobe = locateBinary('ffprobe', settings.ffprobePath || undefined)

  if (!ffmpeg || !ffprobe) {
    const missing = [!ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean).join(' and ')
    cached = {
      ready: false,
      problem:
        `Could not find ${missing}. Install FFmpeg and point Settings → Advanced at it, or run ` +
        '"npm run fetch:ffmpeg" in the project to download the bundled binaries.',
      ffmpegPath: ffmpeg?.path,
      ffprobePath: ffprobe?.path
    }
    cachedKey = key
    return cached
  }

  const version = await binaryVersion(ffmpeg.path)
  if (!version) {
    cached = {
      ready: false,
      problem: `Found ffmpeg at ${ffmpeg.path} but it would not run. Check that the file is executable.`,
      ffmpegPath: ffmpeg.path,
      ffprobePath: ffprobe.path
    }
    cachedKey = key
    return cached
  }

  const capabilities = await detectEncoders(ffmpeg.path)

  cached = {
    ffmpegPath: ffmpeg.path,
    ffprobePath: ffprobe.path,
    ffmpegSource: ffmpeg.source,
    ffprobeSource: ffprobe.source,
    ffmpegVersion: version,
    ready: true,
    capabilities
  }
  cachedKey = key
  return cached
}

export function invalidateEnvironment(): void {
  cached = undefined
  cachedKey = ''
}
