/**
 * Running `qt-faststart`, which moves an MP4's index to the front in one read
 * and one write.
 *
 * It reports no progress, so the caller polls the size of the output instead.
 * It also exits 0 when it declines — "last atom in file was not a moov atom"
 * — without writing anything, so a clean exit proves nothing on its own: the
 * caller checks the output exists and re-probes it.
 *
 * Like ffmpeg, the process comes from the host, so this is the same code here,
 * over SSH, or behind a Tauri command.
 */

import type { HostProcess } from '../host.js'

export interface QtFaststartOptions {
  qtFaststartPath: string
  input: string
  output: string
  signal?: AbortSignal
  /** How to start it, and so where it runs. */
  spawn: (command: string, args: string[]) => HostProcess
  /** Called when the run is aborted, for a host that has to stop it itself. */
  onAbort?: () => void
  /** Polled about once a second while it runs, for progress. */
  onTick?: () => void
}

export class QtFaststartError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly outputTail: string
  ) {
    super(message)
    this.name = 'QtFaststartError'
  }
}

/** Run to completion; resolves with the tail of what it printed. */
export async function runQtFaststart(options: QtFaststartOptions): Promise<string> {
  let child: HostProcess
  try {
    child = options.spawn(options.qtFaststartPath, [options.input, options.output])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new QtFaststartError(`Could not start qt-faststart: ${message}`, null, '')
  }

  // It lists every top-level atom and each one it patches; only the end of
  // that matters, and it is where a refusal is explained.
  const lines: string[] = []
  const collect = (chunk: string): void => {
    lines.push(...chunk.split('\n').filter((line) => line.trim() !== ''))
    if (lines.length > 40) lines.splice(0, lines.length - 40)
  }
  child.onStdout(collect)
  child.onStderr(collect)

  const ticker = options.onTick ? setInterval(options.onTick, 1000) : undefined
  const onAbort = (): void => {
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
      throw new QtFaststartError(`Could not start qt-faststart: ${message}`, null, '')
    }

    const tail = lines.join('\n')
    if (options.signal?.aborted) throw new Error('Cancelled')
    if (code === 0) return tail
    const reason = signalName ? `was killed by ${signalName}` : `exited with code ${code ?? 'unknown'}`
    throw new QtFaststartError(`qt-faststart ${reason}`, code, tail)
  } finally {
    if (ticker) clearInterval(ticker)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
