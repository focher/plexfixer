/**
 * Running ffmpeg with progress reporting and cancellation.
 *
 * The process itself comes from the host, so this is the same code whether
 * ffmpeg is running on this machine, on the far end of an SSH connection, or
 * behind a Tauri command. Nothing here knows which.
 */

import type { HostProcess } from '../host.js'

export interface RunProgress {
  fraction: number
  outTimeSeconds: number
  speed?: string
  fps?: number
  bytesWritten?: number
  frames?: number
}

export interface RunOptions {
  ffmpegPath: string
  args: string[]
  /** Total duration in seconds, used to turn progress into a fraction. */
  durationSeconds?: number
  onProgress?: (progress: RunProgress) => void
  /**
   * Roughly what the output should weigh, used for progress when ffmpeg
   * reports no position. A stream copy lands close to the source size.
   */
  expectedBytes?: number
  signal?: AbortSignal
  /** How to start ffmpeg, and so where it runs. */
  spawn: (command: string, args: string[]) => HostProcess
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
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-stats_period',
    '0.5',
    ...options.args
  ]

  let child: HostProcess
  try {
    child = options.spawn(options.ffmpegPath, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new FfmpegError(`Could not start ffmpeg: ${message}`, null, '')
  }

  // Keep only the tail of stderr: a failing encode can emit a lot of it.
  const stderrChunks: string[] = []
  let stdoutBuffer = ''
  // Last known values: a progress block may arrive split across chunks, and
  // ffmpeg repeats only what changed.
  let outTimeSeconds: number | undefined
  let bytesWritten: number | undefined
  let frames: number | undefined
  let speed: string | undefined
  let fps: number | undefined

  child.onStdout((chunk) => {
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

    // Position in the file is the best measure, but ffmpeg reports it as N/A
    // on some sources — a remux of one used to show no progress at all for the
    // whole job, which is indistinguishable from a hang. Bytes written are
    // always there, and for a stream copy the output lands within a few
    // percent of the input, so they stand in well enough.
    const duration = options.durationSeconds
    const byTime = outTimeSeconds != null && duration && duration > 0 ? outTimeSeconds / duration : undefined
    const byBytes =
      bytesWritten != null && options.expectedBytes && options.expectedBytes > 0
        ? bytesWritten / options.expectedBytes
        : undefined
    const fraction = Math.min(Math.max(byTime ?? byBytes ?? 0, 0), 0.999)

    options.onProgress({ fraction, outTimeSeconds: outTimeSeconds ?? 0, speed, fps, bytesWritten, frames })
  })

  child.onStderr((chunk) => {
    stderrChunks.push(chunk)
    if (stderrChunks.length > 50) stderrChunks.shift()
  })

  const onAbort = (): void => {
    // SIGTERM lets ffmpeg finalise and close the output file cleanly. For a
    // remote run this stops the local ssh client, which does not reliably take
    // the far-end process with it — hence `onAbort`, where the host stops it
    // where it is actually running.
    child.terminate()
    options.onAbort?.()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let code: number | null
    let signalName: string | undefined
    try {
      ;({ code, signalName } = await child.closed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new FfmpegError(`Could not start ffmpeg: ${message}`, null, '')
    }

    const stderrTail = stderrChunks.join('').trim().split('\n').slice(-12).join('\n')

    if (options.signal?.aborted) throw new FfmpegError('Cancelled', code, stderrTail)

    if (code === 0) {
      options.onProgress?.({ fraction: 1, outTimeSeconds: options.durationSeconds ?? 0 })
      return
    }

    const reason = signalName ? `killed by ${signalName}` : `exited with code ${code}`
    throw new FfmpegError(stderrTail ? `ffmpeg ${reason}: ${stderrTail}` : `ffmpeg ${reason}`, code, stderrTail)
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}
