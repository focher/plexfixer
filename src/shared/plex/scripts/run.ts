/**
 * Running one repair script on one file.
 *
 * The script is started by the native side, which has already checked it is
 * approved as it is now; this side hands it the job on stdin, reads what it
 * says, and decides whether it worked: exit code 0, exactly one `result`, and
 * a file where it was told to write one.
 */

import type { RepairHost } from '../../host.js'
import { readScriptLine, splitLines, type ScriptEvent, type ScriptInput } from './protocol.js'

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string
  ) {
    super(message)
    this.name = 'ScriptError'
  }
}

/** The last few kilobytes of what the script wrote to stderr. */
const STDERR_KEPT = 8 * 1024

export async function runScript(args: {
  host: RepairHost
  script: string
  input: ScriptInput
  signal: AbortSignal
  timeoutSeconds?: number
  onEvent: (event: ScriptEvent) => void
}): Promise<{ message?: string }> {
  const { host, script, input, signal } = args
  if (!host.startScript) {
    throw new ScriptError(
      `Repair scripts only run on this computer, and this job is running on ${host.label}.`,
      ''
    )
  }
  if (signal.aborted) throw new ScriptError('Cancelled', '')

  const process = host.startScript(script, JSON.stringify(input))

  // Collected as the output arrives, so the events reach the job as they happen.
  const seen: { carry: string; results: ScriptEvent[]; stderr: string } = { carry: '', results: [], stderr: '' }
  const handle = (line: string): void => {
    const event = readScriptLine(line)
    if (!event) return
    if (event.type === 'result') seen.results.push(event)
    args.onEvent(event)
  }
  process.onStdout((chunk) => {
    const { lines, rest } = splitLines(seen.carry, chunk)
    seen.carry = rest
    lines.forEach(handle)
  })
  process.onStderr((chunk) => {
    seen.stderr = (seen.stderr + chunk).slice(-STDERR_KEPT)
  })

  const stop = (): void => process.terminate()
  signal.addEventListener('abort', stop, { once: true })
  const timedOut = { value: false }
  const timer =
    args.timeoutSeconds !== undefined
      ? setTimeout(() => {
          timedOut.value = true
          process.terminate()
        }, args.timeoutSeconds * 1000)
      : undefined

  try {
    const { code, signalName } = await process.closed
    if (seen.carry) handle(seen.carry)
    if (signal.aborted) throw new ScriptError('Cancelled', seen.stderr)
    if (timedOut.value) {
      throw new ScriptError(`${script} took longer than its ${args.timeoutSeconds}s limit and was stopped`, seen.stderr)
    }
    if (code !== 0) {
      throw new ScriptError(
        `${script} exited with ${code === null ? (signalName ?? 'a signal') : `code ${code}`}`,
        seen.stderr
      )
    }
    if (seen.results.length !== 1) {
      throw new ScriptError(
        seen.results.length === 0
          ? `${script} finished without saying it had: no {"type":"result"} line`
          : `${script} reported ${seen.results.length} results; it must report exactly one`,
        seen.stderr
      )
    }
    if (!(await host.exists(input.output))) {
      throw new ScriptError(`${script} reported success but wrote nothing to ${input.output}`, seen.stderr)
    }
    const [result] = seen.results
    return result?.type === 'result' && result.message ? { message: result.message } : {}
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}
