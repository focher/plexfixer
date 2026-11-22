/**
 * What a repair script is told, and how what it says back is read.
 *
 * In: one JSON document on stdin, then end of input. It names the file to
 * read, the file to write, the flags that led here, the script's parameters,
 * and the ffmpeg and ffprobe the app is using — a script that needs to pull a
 * track out or put one back has the same tools the app does.
 *
 * Out: one JSON object per line on stdout.
 *
 *   {"type":"progress","fraction":0.4,"message":"Cleaning track 3"}
 *   {"type":"log","level":"info","text":"Removed 4 lines","detail":"..."}
 *   {"type":"result","message":"Removed 4 advert lines"}
 *
 * Exactly one `result`, and the file at `output`, mean it worked. A line that
 * is not one of these is kept as log text, so a stray `print` does no harm.
 */

import type { AppSettings, FindingCode, MediaFile } from '../../types.js'
import type { ParamValues } from '../modules/params.js'
import { SCRIPT_PROTOCOL } from './manifest.js'

export interface ScriptInput {
  protocol: typeof SCRIPT_PROTOCOL
  script: { id: string; version: string }
  /** The file to read. */
  input: string
  /** Where to write the repaired file. It does not exist yet. */
  output: string
  /** The flags on this file that are bound to the script. */
  flags: readonly FindingCode[]
  params: ParamValues
  /** The file as it was scanned: its streams, their languages and dispositions. */
  file: Pick<MediaFile, 'path' | 'container' | 'durationSeconds' | 'streams' | 'tags'>
  ffmpegPath: string
  ffprobePath: string
  /** The language the user prefers, which several kinds of clean-up care about. */
  preferredSubtitleLanguage: string
}

export function buildScriptInput(args: {
  id: string
  version: string
  input: string
  output: string
  flags: readonly FindingCode[]
  params: ParamValues
  file: MediaFile
  ffmpegPath: string
  ffprobePath: string
  settings: Pick<AppSettings, 'preferredSubtitleLanguage'>
}): ScriptInput {
  return {
    protocol: SCRIPT_PROTOCOL,
    script: { id: args.id, version: args.version },
    input: args.input,
    output: args.output,
    flags: args.flags,
    params: args.params,
    file: {
      path: args.file.path,
      container: args.file.container,
      durationSeconds: args.file.durationSeconds,
      streams: args.file.streams,
      tags: args.file.tags
    },
    ffmpegPath: args.ffmpegPath,
    ffprobePath: args.ffprobePath,
    preferredSubtitleLanguage: args.settings.preferredSubtitleLanguage
  }
}

export type ScriptEvent =
  | { type: 'progress'; fraction: number; message?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string; detail?: string }
  | { type: 'result'; message?: string }

const LEVELS = ['info', 'warn', 'error'] as const

/** One line of a script's output, as an event; anything unrecognised is log text. */
export function readScriptLine(line: string): ScriptEvent | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  const asText: ScriptEvent = { type: 'log', level: 'info', text: trimmed }
  const parsed = ((): unknown => {
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  })()
  if (typeof parsed !== 'object' || parsed === null) return asText
  const event = parsed as Record<string, unknown>
  const message = typeof event.message === 'string' ? event.message : undefined
  switch (event.type) {
    case 'progress':
      return typeof event.fraction === 'number' && Number.isFinite(event.fraction)
        ? { type: 'progress', fraction: Math.min(1, Math.max(0, event.fraction)), ...(message ? { message } : {}) }
        : asText
    case 'log':
      return typeof event.text === 'string'
        ? {
            type: 'log',
            level: LEVELS.includes(event.level as (typeof LEVELS)[number]) ? (event.level as (typeof LEVELS)[number]) : 'info',
            text: event.text,
            ...(typeof event.detail === 'string' ? { detail: event.detail } : {})
          }
        : asText
    case 'result':
      return { type: 'result', ...(message ? { message } : {}) }
    default:
      return asText
  }
}

/**
 * Splits streamed output into whole lines.
 *
 * Output arrives in chunks of any size, so a line can be cut anywhere. Returns
 * the complete lines and what is left over for the next chunk.
 */
export function splitLines(carry: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (carry + chunk).split('\n')
  return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] ?? '' }
}
