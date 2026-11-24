/**
 * Listening to a film: where the speech is, and getting the audio out.
 *
 * This is the one part of the subtitle work that runs a process, so it is the
 * one part that needs a host. Everything above it — the correlation, the
 * chunking, the batching — is arithmetic on what this produces.
 *
 * It does not go through `runFfmpeg`, which every other ffmpeg call in this app
 * does, and the reason is one argument: that runner passes `-loglevel error`,
 * and `silencedetect` reports what it found at `info`. Run through it, the
 * filter does its work and says nothing, and the result is a film with no
 * silence in it anywhere. So this has its own small runner, which keeps the
 * level up and reads the filter's output as it arrives rather than keeping the
 * tail of stderr the way a failure report wants to.
 */

import type { HostProcess } from '../host.js'
import { SILENCE_FILTER, speechIntervals, type SpeechInterval } from './silence.js'

export interface ListenOptions {
  ffmpegPath: string
  sourcePath: string
  /** The audio track to listen to — the original-language one, not a dub. */
  streamIndex: number
  durationSeconds: number
  spawn: (command: string, args: string[]) => HostProcess
  signal?: AbortSignal
  onAbort?: () => void
  /** 0..1, from ffmpeg's own position reports. */
  onProgress?: (fraction: number) => void
}

/**
 * The ffmpeg run that finds the silence.
 *
 * `-f null -` because nothing is being written: the filter's report is the
 * output, and asking for a file would spend the time writing one. `-vn` keeps
 * it from decoding the picture, which is the whole of the cost otherwise — the
 * audio of a two-hour film decodes in well under a minute, its video does not.
 */
export function buildListenCommand(sourcePath: string, streamIndex: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    // Up from `error`, which is what the shared runner uses: silencedetect
    // reports at info and is silent below it.
    '-loglevel',
    'info',
    '-progress',
    'pipe:1',
    '-stats_period',
    '1',
    '-i',
    sourcePath,
    '-map',
    `0:${streamIndex}`,
    '-vn',
    '-af',
    SILENCE_FILTER,
    '-f',
    'null',
    '-'
  ]
}

export class ListenError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string
  ) {
    super(message)
    this.name = 'ListenError'
  }
}

/**
 * Work out when somebody is speaking, by finding when nobody is.
 *
 * Only the filter's own lines are kept out of stderr. ffmpeg at `info` is
 * talkative — every stream of a film, every decoder — and a two-hour run
 * produces a few hundred kilobytes of it that nothing here needs. The tail is
 * kept separately and only so that a failure can say what ffmpeg complained
 * about.
 */
export async function listenForSpeech(options: ListenOptions): Promise<SpeechInterval[]> {
  let child: HostProcess
  try {
    child = options.spawn(options.ffmpegPath, buildListenCommand(options.sourcePath, options.streamIndex))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ListenError(`Could not start ffmpeg: ${message}`, '')
  }

  const silenceLines: string[] = []
  const tail: string[] = []
  let stderrBuffer = ''
  let stdoutBuffer = ''

  child.onStderr((chunk) => {
    stderrBuffer += chunk
    const lines = stderrBuffer.split('\n')
    stderrBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.includes('silence_start') || line.includes('silence_end')) {
        silenceLines.push(line)
        continue
      }
      tail.push(line)
      if (tail.length > 20) tail.shift()
    }
  })

  child.onStdout((chunk) => {
    if (!options.onProgress) return
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const [key, raw] = line.split('=')
      if (key?.trim() !== 'out_time_us' && key?.trim() !== 'out_time_ms') continue
      const microseconds = Number(raw?.trim())
      if (!Number.isFinite(microseconds) || microseconds < 0) continue
      if (options.durationSeconds > 0) {
        options.onProgress(Math.min(0.999, microseconds / 1_000_000 / options.durationSeconds))
      }
    }
  })

  const onAbort = (): void => {
    child.terminate()
    options.onAbort?.()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let code: number | null
    try {
      ;({ code } = await child.closed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ListenError(`Could not start ffmpeg: ${message}`, '')
    }

    // Anything still in the buffer when the process ended — the last line often
    // has no newline after it, and on a film that ends quiet that line is the
    // last silence_start.
    if (stderrBuffer.includes('silence_')) silenceLines.push(stderrBuffer)

    if (options.signal?.aborted) throw new ListenError('Cancelled', tail.join('\n'))
    if (code !== 0) {
      throw new ListenError(`ffmpeg exited with code ${code}`, tail.slice(-12).join('\n'))
    }

    options.onProgress?.(1)
    return speechIntervals(silenceLines.join('\n'), options.durationSeconds)
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}
