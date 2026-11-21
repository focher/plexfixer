/**
 * Deciding whether a hand-written rule matches a file.
 *
 * Nothing here executes anything. A condition is a subject, a comparison and
 * some values, and this compares them — that is the whole of what a user's
 * script can make the app do.
 *
 * Two rules worth knowing, both chosen so a rule cannot fire on an absence it
 * never meant to ask about:
 *
 * - A question the file does not answer is never true. `video.profile is not
 *   high` is false on a file that does not say what its profile is, rather than
 *   true-by-default. `is missing` is the one way to ask about silence.
 * - A question about tracks is asked of every track, and matches if any track
 *   answers it. The tracks that did answer are the ones the finding points at,
 *   and the ones a `drop-track` acts on.
 */

import type { MediaContext } from '../framework.js'
import type { ScriptCondition, ParsedScript } from './parse.js'
import type { Reading, SubjectScope } from './vocabulary.js'

export interface ScriptMatch {
  matched: boolean
  /** Tracks that answered a question, by the kind of track they are. */
  byScope: Record<SubjectScope, number[]>
  /** Every track the rule pointed at, in stream order. */
  streamIndexes: number[]
}

function compare(reading: Reading, condition: ScriptCondition): boolean {
  const { operator, values } = condition
  const value = reading.value

  if (operator.name === 'is missing') return value === undefined
  if (value === undefined) return false
  if (operator.name === 'is set') return true

  const sameText = (a: string | number | boolean, b: string | number | boolean): boolean =>
    typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b

  switch (operator.name) {
    case 'is':
      return sameText(value, values[0])
    case 'is not':
      return !sameText(value, values[0])
    case 'in':
      return values.some((candidate) => sameText(value, candidate))
    case 'not in':
      return !values.some((candidate) => sameText(value, candidate))
    case 'contains':
      return String(value).toLowerCase().includes(String(values[0]).toLowerCase())
    case 'above':
      return Number(value) > Number(values[0])
    case 'below':
      return Number(value) < Number(values[0])
    case 'at least':
      return Number(value) >= Number(values[0])
    case 'at most':
      return Number(value) <= Number(values[0])
    default:
      return false
  }
}

export function evaluateScript(script: ParsedScript, context: MediaContext): ScriptMatch {
  const byScope: Record<SubjectScope, number[]> = { file: [], video: [], audio: [], subtitle: [] }
  let matched = true

  for (const condition of script.conditions) {
    const readings = condition.subject.read(context)
    const hits = readings.filter((reading) => compare(reading, condition))
    if (hits.length === 0) {
      matched = false
      // Keep going: the caller only wants the verdict, and stopping early would
      // make the matched-track list depend on the order conditions were written.
      continue
    }
    for (const hit of hits) {
      if (hit.streamIndex === undefined) continue
      const list = byScope[condition.subject.scope]
      if (!list.includes(hit.streamIndex)) list.push(hit.streamIndex)
    }
  }

  const streamIndexes = [...byScope.video, ...byScope.audio, ...byScope.subtitle].sort((a, b) => a - b)
  return { matched, byScope, streamIndexes }
}
