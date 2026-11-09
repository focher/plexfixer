/**
 * Running ffmpeg with progress reporting and cancellation.
 */

import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EncoderCapabilities } from '@shared/types.js'

const execFileAsync = promisify(execFile)

export interface RunOptions {
  ffmpegPath: string
  args: string[]
  /** Total duration in seconds, used to turn progress into a fraction. */
  durationSeconds?: number
  onProgress?: (progress: { fraction: number; outTimeSeconds: number; speed?: string; fps?: number }) => void
  signal?: AbortSignal
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
 * more robust than scraping the human-readable stderr output.
 */
export async function runFfmpeg(options: RunOptions): Promise<void> {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-stats_period', '0.5', ...options.args]

  return new Promise<void>((resolve, reject) => {
    const child = spawn(options.ffmpegPath, args, { windowsHide: true })

    // Keep only the tail of stderr: a failing encode can emit a lot of it.
    const stderrLines: string[] = []
    let stdoutBuffer = ''
    let settled = false

    const onAbort = (): void => {
      // SIGTERM lets ffmpeg finalise and close the output file cleanly.
      child.kill('SIGTERM')
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

      let outTimeSeconds: number | undefined
      let speed: string | undefined
      let fps: number | undefined

      for (const line of lines) {
        const [key, value] = line.split('=', 2)
        if (value == null) continue
        switch (key.trim()) {
          case 'out_time_us':
          case 'out_time_ms': {
            // Despite the name, ffmpeg reports out_time_ms in microseconds.
            const micros = Number(value)
            if (Number.isFinite(micros) && micros >= 0) outTimeSeconds = micros / 1_000_000
            break
          }
          case 'speed':
            speed = value.trim()
            break
          case 'fps': {
            const parsed = Number(value)
            if (Number.isFinite(parsed)) fps = parsed
            break
          }
        }
      }

      if (outTimeSeconds != null && options.onProgress) {
        const total = options.durationSeconds
        const fraction = total && total > 0 ? Math.min(outTimeSeconds / total, 0.999) : 0
        options.onProgress({ fraction, outTimeSeconds, speed, fps })
      }
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
export async function detectEncoders(ffmpegPath: string): Promise<EncoderCapabilities> {
  let available: string[] = []
  let ffmpegVersion: string | undefined

  try {
    const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-encoders'], {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    })
    available = HARDWARE_ENCODERS.filter((name) => new RegExp(`\\b${name}\\b`).test(stdout))
  } catch {
    available = []
  }

  try {
    const { stdout } = await execFileAsync(ffmpegPath, ['-version'], { maxBuffer: 1024 * 1024, windowsHide: true })
    ffmpegVersion = stdout.split('\n', 1)[0]?.trim()
  } catch {
    ffmpegVersion = undefined
  }

  // Confirm NVENC really works; on a machine with no NVIDIA driver the encoder
  // is listed but fails at open time, which would otherwise surface as a
  // mystifying failure on the first real transcode.
  let nvenc = available.some((name) => name.endsWith('_nvenc'))
  if (nvenc) nvenc = await probeEncoderWorks(ffmpegPath, 'h264_nvenc')

  let videotoolbox = available.some((name) => name.endsWith('_videotoolbox'))
  if (videotoolbox) videotoolbox = await probeEncoderWorks(ffmpegPath, 'h264_videotoolbox')

  let qsv = available.some((name) => name.endsWith('_qsv'))
  if (qsv) qsv = await probeEncoderWorks(ffmpegPath, 'h264_qsv')

  let amf = available.some((name) => name.endsWith('_amf'))
  if (amf) amf = await probeEncoderWorks(ffmpegPath, 'h264_amf')

  return { platform: process.platform, available, nvenc, videotoolbox, qsv, amf, ffmpegVersion }
}

/** Encode a few frames of test pattern to confirm an encoder opens on this machine. */
export async function probeEncoderWorks(ffmpegPath: string, encoder: string): Promise<boolean> {
  try {
    await execFileAsync(
      ffmpegPath,
      [
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
      ],
      { timeout: 30_000, windowsHide: true }
    )
    return true
  } catch {
    return false
  }
}
