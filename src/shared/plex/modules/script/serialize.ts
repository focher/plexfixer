/**
 * Writing a rule back out as text.
 *
 * The block editor does not have a model of its own: it edits the same parsed
 * structure the text produces, and this turns that structure back into the
 * script. So the two editors are two views of one rule rather than two formats
 * that have to be kept in step.
 *
 * What survives a trip through here: every step, every value, and every comment
 * — attached to the step it sat above, so a note about a condition follows that
 * condition even if the condition moves.
 *
 * What does not: the order the steps were written in, and how they were spaced
 * and wrapped. The output is canonical — name, then the explanations, then the
 * conditions, then the report, then the fixes — because the block editor has no
 * way to express "this fix was written above that condition", and inventing one
 * would be inventing meaning the language does not have.
 */

import type { ParsedScript, ScriptCondition } from './parse.js'

/** Text that would be read back as something other than itself needs quoting. */
function quoteIfNeeded(value: string): string {
  // The empty string among them: a condition still being filled in has one,
  // and written bare it would read back as a missing value rather than a
  // blank one — turning a half-built rule into a broken one.
  const needs =
    value === '' || value.startsWith('"') || value.includes(',') || value.trim() !== value
  return needs ? quote(value) : value
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

/**
 * Break a long explanation over several lines.
 *
 * Continuation lines are indented, which is what makes them continuations, and
 * the parser joins them back with single spaces — so a wrapped line reads back
 * as exactly what went in, and wrapping it again gives the same result.
 */
function wrapQuoted(text: string, indent: string, width = 76): string[] {
  const body = quote(text)
  if (indent.length + body.length <= width) return [body]

  const words = body.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (current !== '' && indent.length + candidate.length > width) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

function conditionLine(condition: ScriptCondition): string {
  const { subject, operator, values } = condition
  if (values.length === 0) return `when ${subject.name} ${operator.name}`

  const written = values.map((value) =>
    typeof value === 'string' ? quoteIfNeeded(value) : String(value)
  )
  return `when ${subject.name} ${operator.name} ${written.join(', ')}`
}

export function serializeScript(script: ParsedScript): string {
  const out: string[] = []
  const comments = script.comments

  const block = (lines: string[], above: string[] = []): void => {
    if (out.length > 0) out.push('')
    out.push(...above, ...lines)
  }

  block([`name ${quoteIfNeeded(script.name)}`], comments.name)

  // The four explanations, each only written when the author wrote one: the
  // rest are worked out from the rule, and writing those back would turn a
  // generated sentence into something the author now owns.
  const prose: [string, string | undefined, string[]][] = [
    ['summary', script.summary, comments.summary],
    ['does', script.whatItDoes, comments.whatItDoes],
    ['how', script.howItWorks, comments.howItWorks],
    ['off', script.ifDisabled, comments.ifDisabled]
  ]
  for (const [directive, value, above] of prose) {
    if (value === undefined) continue
    block([`${directive} ${quoteIfNeeded(value)}`], above)
  }

  script.conditions.forEach((condition, index) => {
    block([conditionLine(condition)], comments.when[index] ?? [])
  })

  if (script.report) {
    const indent = ' '.repeat('report '.length)
    const lines = [`report ${script.report.severity} ${quote(script.report.title)}`]
    if (script.report.detail !== '') {
      for (const piece of wrapQuoted(script.report.detail, indent)) lines.push(`${indent}${piece}`)
    }
    block(lines, comments.report)
  }

  script.fixes.forEach((fix, index) => {
    block([`fix ${fix}`], comments.fix[index] ?? [])
  })

  if (comments.trailing.length > 0) block(comments.trailing)

  return `${out.join('\n')}\n`
}
