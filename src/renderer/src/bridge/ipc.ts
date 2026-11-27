/**
 * Every call across the bridge, with a note of it kept.
 *
 * This is a drop-in for `@tauri-apps/api`'s `invoke`, and the bridge imports
 * it instead. Routing every call through one place means the report can say
 * which of them is slow and which one has not come back — the two questions a
 * queue that appears stuck actually raises, and neither of which the job log
 * can answer, because a call that hangs never gets as far as logging anything.
 *
 * What is written down is the command and a short description of its
 * arguments. Values that could be a credential are never written: see
 * `redact` and `safeUrl` in the trace module.
 */

import { invoke as rawInvoke } from '@tauri-apps/api/core'
import { begin, redact, safeUrl } from '@shared/trace.js'

/**
 * Commands that run constantly and say nothing by themselves.
 *
 * They are still timed and still counted in the totals — a thousand slow range
 * reads is exactly the sort of thing this exists to catch — but the start of
 * each one is not written as its own line, or the log would be nothing else.
 * The *unfinished* ones still appear, because those are recorded separately.
 */
const QUIET = new Set(['host_stat', 'host_exists', 'host_read_range'])

/** A short, safe description of what a call was asked to do. */
function describe(command: string, args?: Record<string, unknown>): string {
  if (!args) return command

  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value == null) continue
    if (key === 'request' && typeof value === 'object' && 'url' in (value as Record<string, unknown>)) {
      const request = value as { url: string; method?: string }
      parts.push(`${request.method ?? 'GET'} ${safeUrl(request.url)}`)
      continue
    }
    if (key === 'patch' && typeof value === 'object') {
      parts.push(`patch{${Object.keys(value as object).join(',')}}`)
      continue
    }
    if (key === 'bytes' || key === 'body' || key === 'input') {
      parts.push(`${key}=${Array.isArray(value) ? value.length : String(value).length}B`)
      continue
    }
    if (key === 'args' && Array.isArray(value)) {
      // The arguments of a binary this app assembled: no credential ever goes
      // in one, and which flags were used is the whole question when ffmpeg
      // refuses something.
      parts.push(value.map((item) => String(item)).join(' ').slice(0, 300))
      continue
    }
    if (key === 'stages' && Array.isArray(value)) {
      parts.push(`${value.length} stages`)
      continue
    }
    const text = redact(key, value)
    if (text !== '') parts.push(key === 'command' || key === 'path' ? text : `${key}=${text}`)
  }
  return parts.length > 0 ? `${command} ${parts.join(' ')}` : command
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const done = begin('ipc', describe(command, args), { quiet: QUIET.has(command) })
  try {
    const value = await rawInvoke<T>(command, args)
    done()
    return value
  } catch (error) {
    done({ failed: error })
    throw error
  }
}
