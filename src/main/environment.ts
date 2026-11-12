/**
 * Resolving the ffmpeg toolchain and the machine's encoder capabilities once,
 * then caching it for the session.
 */

import type { AppSettings, EnvironmentInfo } from '@shared/types.js'
import { binaryVersion, locateBinary } from './ffmpeg/locate.js'
import { detectEncoders } from './ffmpeg/run.js'
import { hostFor, remoteTargetFor } from './host.js'
import { checkRemote } from './remote/check.js'

export type Environment = EnvironmentInfo

let cached: Environment | undefined
let cachedKey = ''

/**
 * Detection runs a handful of short test encodes, so it is cached against the
 * settings that affect it and only redone when those change.
 */
export async function resolveEnvironment(settings: AppSettings, force = false): Promise<Environment> {
  const key = [
    settings.ffmpegPath,
    settings.ffprobePath,
    settings.remoteEnabled ? '1' : '0',
    settings.remoteHost,
    settings.remotePort,
    settings.remoteFfmpegPath,
    settings.remoteFfprobePath
  ].join('|')
  if (!force && cached && cachedKey === key) return cached

  // Remote mode asks the far end instead: the binaries that matter are the
  // ones on the machine that will do the work, and so are the encoders.
  const target = remoteTargetFor(settings)
  if (target) {
    cached = await resolveRemoteEnvironment(settings)
    cachedKey = key
    return cached
  }

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

/** Platform word from `uname -s`, for the encoder capabilities. */
function platformFrom(unameOutput: string | undefined): NodeJS.Platform | undefined {
  const first = unameOutput?.split(/\s+/)[0]?.toLowerCase()
  if (first === 'linux') return 'linux'
  if (first === 'darwin') return 'darwin'
  if (first?.startsWith('freebsd')) return 'freebsd'
  return undefined
}

async function resolveRemoteEnvironment(settings: AppSettings): Promise<Environment> {
  const host = hostFor(settings)
  const target = remoteTargetFor(settings)
  if (!target) return { ready: false, problem: 'No remote host is set.' }

  const check = await checkRemote(target, settings)
  if (!check.ok || !check.ffmpegPath || !check.ffprobePath) {
    return {
      ready: false,
      problem: check.problem ?? `Could not use ffmpeg on ${target.host}.`,
      hint: check.hint,
      remote: { host: target.host, platform: check.platform }
    }
  }

  // The test encodes run on the far end, so what comes back is what that
  // machine can really do — an NVENC card in the NAS, not in this laptop.
  const capabilities = await detectEncoders(check.ffmpegPath, {
    exec: (command, args) => host.exec(command, args, { timeoutMs: 60_000 }),
    platform: platformFrom(check.platform)
  })

  return {
    ready: true,
    ffmpegPath: check.ffmpegPath,
    ffprobePath: check.ffprobePath,
    ffmpegSource: settings.remoteFfmpegPath.trim() ? 'settings' : 'path',
    ffprobeSource: settings.remoteFfprobePath.trim() ? 'settings' : 'path',
    ffmpegVersion: check.ffmpegVersion,
    capabilities,
    remote: { host: target.host, platform: check.platform }
  }
}
