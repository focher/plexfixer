/**
 * Running ffmpeg with progress reporting and cancellation.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EncoderCapabilities } from '@shared/types.js'

const execFileAsync = promisify(execFile)

export interface RunOptions {
  ffmpegPath: string
  args: string[]
  /** Total duration in seconds, used to turn progress into a fraction. */
  durationSeconds?: number
  onProgress?: (progress: {
    fraction: number
    outTimeSeconds: number
    speed?: string
    fps?: number
    bytesWritten?: number
    frames?: number
  }) => void
  /**
   * Roughly what the output should weigh, used for progress when ffmpeg
   * reports no position. A stream copy lands close to the source size.
   */
  expectedBytes?: number
  signal?: AbortSignal
  /**
   * How to start ffmpeg. The default starts it here; the remote host starts it
   * on the far end, where its stdout — and so `-progress pipe:1` — arrives
   * over the same pipe.
   */
  spawn?: (command: string, args: string[]) => ChildProcessWithoutNullStreams
  /** Called when the run is aborted, for a host that has to stop it itself. */
  onAbort?: () => void
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderrTail: string
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

/**
 * Run ffmpeg to completion.
 *
 * Progress comes from `-progress pipe:1`, which emits `key=value` lines — far
 * more robust than scraping the human-readable stderr output. Every value in
 * them can be `N/A`, including the position, so none of them is relied on
 * alone.
 */
export async function runFfmpeg(options: RunOptions): Promise<void> {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-stats_period', '0.5', ...options.args]

  return new Promise<void>((resolve, reject) => {
    const child = options.spawn
      ? options.spawn(options.ffmpegPath, args)
      : spawn(options.ffmpegPath, args, { windowsHide: true })

    // Keep only the tail of stderr: a failing encode can emit a lot of it.
    const stderrLines: string[] = []
    let stdoutBuffer = ''
    let settled = false
    // Last known values: a progress block may arrive split across chunks, and
    // ffmpeg repeats only what changed.
    let outTimeSeconds: number | undefined
    let bytesWritten: number | undefined
    let frames: number | undefined
    let speed: string | undefined
    let fps: number | undefined

    const onAbort = (): void => {
      // SIGTERM lets ffmpeg finalise and close the output file cleanly. For a
      // remote run this kills the local ssh client, which does not reliably
      // take the far-end process with it — hence `onAbort`, where the host
      // stops it where it is actually running.
      child.kill('SIGTERM')
      options.onAbort?.()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      let sawBlock = false

      for (const line of lines) {
        const equals = line.indexOf('=')
        if (equals < 0) continue
        const key = line.slice(0, equals).trim()
        // ffmpeg writes "N/A" for anything it cannot work out yet, which
        // Number() turns into NaN — every value here has to survive that.
        const raw = line.slice(equals + 1).trim()
        const numeric = Number(raw)
        const usable = raw !== 'N/A' && Number.isFinite(numeric)

        switch (key) {
          case 'out_time_us':
          case 'out_time_ms':
            // Despite the name, ffmpeg reports out_time_ms in microseconds.
            if (usable && numeric >= 0) outTimeSeconds = numeric / 1_000_000
            break
          case 'total_size':
            if (usable && numeric >= 0) bytesWritten = numeric
            break
          case 'frame':
            if (usable && numeric >= 0) frames = numeric
            break
          case 'speed':
            speed = raw === 'N/A' ? undefined : raw
            break
          case 'fps':
            if (usable) fps = numeric
            break
          case 'progress':
            sawBlock = true
            break
        }
      }

      if (!sawBlock || !options.onProgress) return

      // Position in the file is the best measure, but ffmpeg reports it as
      // N/A on some sources — a remux of one used to show no progress at all
      // for the whole job, which is indistinguishable from a hang. Bytes
      // written are always there, and for a stream copy the output lands
      // within a few percent of the input, so they stand in well enough.
      const duration = options.durationSeconds
      const byTime = outTimeSeconds != null && duration && duration > 0 ? outTimeSeconds / duration : undefined
      const byBytes =
        bytesWritten != null && options.expectedBytes && options.expectedBytes > 0
          ? bytesWritten / options.expectedBytes
          : undefined
      const fraction = Math.min(Math.max(byTime ?? byBytes ?? 0, 0), 0.999)

      options.onProgress({
        fraction,
        outTimeSeconds: outTimeSeconds ?? 0,
        speed,
        fps,
        bytesWritten,
        frames
      })
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrLines.push(chunk)
      if (stderrLines.length > 50) stderrLines.shift()
    })

    child.on('error', (error) => {
      finish(() => reject(new FfmpegError(`Could not start ffmpeg: ${error.message}`, null, '')))
    })

    child.on('close', (code, signalName) => {
      const stderrTail = stderrLines.join('').trim().split('\n').slice(-12).join('\n')
      if (options.signal?.aborted) {
        finish(() => reject(new FfmpegError('Cancelled', code, stderrTail)))
        return
      }
      if (code === 0) {
        options.onProgress?.({ fraction: 1, outTimeSeconds: options.durationSeconds ?? 0 })
        finish(resolve)
        return
      }
      const reason = signalName ? `killed by ${signalName}` : `exited with code ${code}`
      finish(() =>
        reject(new FfmpegError(stderrTail ? `ffmpeg ${reason}: ${stderrTail}` : `ffmpeg ${reason}`, code, stderrTail))
      )
    })
  })
}

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
   * How to run ffmpeg. The default runs it here; a remote host passes its own
   * so the encoders reported are the ones on the machine that will do the
   * work, which is the only answer worth having.
   */
  exec?: (command: string, args: string[]) => Promise<string>
  /** The platform those encoders belong to. */
  platform?: NodeJS.Platform
}

const localExec = async (command: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  return stdout
}

export async function detectEncoders(ffmpegPath: string, options: DetectOptions = {}): Promise<EncoderCapabilities> {
  const exec = options.exec ?? localExec
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

  return { platform: options.platform ?? process.platform, available, nvenc, videotoolbox, qsv, amf, ffmpegVersion }
}

/** Encode a few frames of test pattern to confirm an encoder opens on this machine. */
export async function probeEncoderWorks(
  ffmpegPath: string,
  encoder: string,
  exec: (command: string, args: string[]) => Promise<string> = localExec
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
