/**
 * Reading a hand-written rule.
 *
 * The language is one directive per line, because the thing being written is a
 * list of steps and a list of steps is what it should look like. There is no
 * nesting, no expressions and nothing to execute: a script is read into a
 * handful of comparisons and a finding, and the evaluator does nothing with it
 * but compare values. A script cannot reach the disk, the network or the app —
 * not because it is sandboxed, but because there is nothing in the language
 * that could ask.
 *
 * Every problem carries the line it is on. A rule that will not parse is never
 * silently skipped: the editor shows the line, and the rule is marked broken in
 * Settings rather than quietly doing nothing.
 */

import {
  OPERATORS_BY_LENGTH,
  SEVERITIES,
  fixNamed,
  subjectNamed,
  type FixName,
  type Operator,
  type ScriptSeverity,
  type Subject
} from './vocabulary.js'

export interface ScriptCondition {
  subject: Subject
  operator: Operator
  /** Already checked against the subject's type; empty for "is set" / "is missing". */
  values: (string | number | boolean)[]
  /** As written, for the English rendering. */
  wrote: string
  line: number
}

export interface ScriptReport {
  severity: ScriptSeverity
  title: string
  detail: string
}

/**
 * The comment lines that sat above each step.
 *
 * Kept because a script is edited in two places — as text, and as blocks — and
 * the block editor rewrites the text from this structure every time something
 * changes. Anything not kept here is anything the author loses for having used
 * the other editor once, and their own notes are the last thing that should go.
 */
export interface ScriptComments {
  name: string[]
  summary: string[]
  whatItDoes: string[]
  howItWorks: string[]
  ifDisabled: string[]
  /** One entry per condition, in the same order. */
  when: string[][]
  report: string[]
  /** One entry per fix, in the same order. */
  fix: string[][]
  /** Comments sitting after the last step. */
  trailing: string[]
}

export function emptyComments(): ScriptComments {
  return {
    name: [],
    summary: [],
    whatItDoes: [],
    howItWorks: [],
    ifDisabled: [],
    when: [],
    report: [],
    fix: [],
    trailing: []
  }
}

export interface ParsedScript {
  name: string
  summary?: string
  whatItDoes?: string
  howItWorks?: string
  ifDisabled?: string
  conditions: ScriptCondition[]
  report?: ScriptReport
  fixes: FixName[]
  comments: ScriptComments
}

export interface ScriptProblem {
  /** 1-based, matching what the editor shows. */
  line: number
  message: string
}

export interface ParseResult {
  script?: ParsedScript
  problems: ScriptProblem[]
}

type TextField = 'name' | 'summary' | 'whatItDoes' | 'howItWorks' | 'ifDisabled'

const TEXT_DIRECTIVES: Record<string, TextField> = {
  name: 'name',
  summary: 'summary',
  does: 'whatItDoes',
  how: 'howItWorks',
  off: 'ifDisabled'
}

const DIRECTIVES = [...Object.keys(TEXT_DIRECTIVES), 'when', 'report', 'fix']

/**
 * Lines, with continuations folded in.
 *
 * A line that starts with a space belongs to the one above it, which is how a
 * long piece of explanatory text can be laid out as a paragraph instead of
 * running off the side of the editor.
 */
interface LogicalLine {
  text: string
  line: number
  /** The comment lines directly above it. */
  comments: string[]
}

function logicalLines(source: string): { lines: LogicalLine[]; trailing: string[] } {
  const out: LogicalLine[] = []
  const raw = source.split(/\r?\n/)
  // Comments seen since the last directive; they belong to whatever comes next.
  let pending: string[] = []

  // The whole script is un-indented first. A script pasted out of a document,
  // or typed with everything shifted across, is indented uniformly — and
  // without this that first space would make every line a continuation of the
  // one above it, turning the rule into one very long directive. What counts
  // as a continuation is being indented *further* than the script itself.
  let common = Infinity
  for (const line of raw) {
    if (line.trim() === '') continue
    common = Math.min(common, line.length - line.trimStart().length)
  }
  if (!Number.isFinite(common)) common = 0

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].slice(common)
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) {
      pending.push(trimmed)
      continue
    }

    const isContinuation = /^\s/.test(line) && out.length > 0
    if (isContinuation) {
      out[out.length - 1].text += ` ${trimmed}`
      continue
    }
    out.push({ text: trimmed, line: i + 1, comments: pending })
    pending = []
  }

  return { lines: out, trailing: pending }
}

/**
 * The quoted pieces of a line, in order.
 *
 * `\"` puts a quote inside one. Returns undefined when a quote is left open,
 * which is the one mistake worth naming specially — everything after it would
 * otherwise be swallowed in silence.
 */
function quotedParts(rest: string): string[] | undefined {
  const parts: string[] = []
  let index = 0

  while (index < rest.length) {
    while (index < rest.length && /[\s,]/.test(rest[index])) index++
    if (index >= rest.length) break
    if (rest[index] !== '"') return undefined

    index++
    let value = ''
    let closed = false
    while (index < rest.length) {
      const character = rest[index]
      if (character === '\\' && rest[index + 1] === '"') {
        value += '"'
        index += 2
        continue
      }
      if (character === '"') {
        closed = true
        index++
        break
      }
      value += character
      index++
    }
    if (!closed) return undefined
    parts.push(value)
  }

  return parts
}

/** `divx, dx50` or `"a, b", c` — commas separate, quotes protect. */
function listValues(rest: string): string[] {
  if (rest.trim().startsWith('"')) return quotedParts(rest) ?? []
  return rest
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function coerce(
  value: string,
  subject: Subject
): { ok: true; value: string | number | boolean } | { ok: false; message: string } {
  if (subject.type === 'number') {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return { ok: false, message: `"${value}" is not a number` }
    return { ok: true, value: parsed }
  }
  if (subject.type === 'boolean') {
    const lowered = value.toLowerCase()
    if (lowered !== 'true' && lowered !== 'false') {
      return { ok: false, message: `"${value}" is not true or false` }
    }
    return { ok: true, value: lowered === 'true' }
  }
  return { ok: true, value }
}

function parseCondition(rest: string, line: number, problems: ScriptProblem[]): ScriptCondition | undefined {
  const match = /^(\S+)\s*(.*)$/.exec(rest)
  if (!match) {
    problems.push({ line, message: 'A "when" line needs something to ask about, such as video.codec' })
    return undefined
  }

  const [, subjectName, remainder] = match
  const subject = subjectNamed(subjectName)
  if (!subject) {
    problems.push({ line, message: `There is nothing called "${subjectName}" to ask about` })
    return undefined
  }

  const operator = OPERATORS_BY_LENGTH.find(
    (candidate) =>
      remainder.toLowerCase() === candidate.name ||
      remainder.toLowerCase().startsWith(`${candidate.name} `)
  )
  if (!operator) {
    problems.push({
      line,
      message: `"${subject.name}" needs a comparison after it, such as "is", "in", "above" or "contains"`
    })
    return undefined
  }

  if (!operator.types.includes(subject.type)) {
    problems.push({
      line,
      message: `"${operator.name}" cannot be used on ${subject.name}, which is ${
        subject.type === 'number' ? 'a number' : subject.type === 'boolean' ? 'true or false' : 'text'
      }`
    })
    return undefined
  }

  const valueText = remainder.slice(operator.name.length).trim()
  const takesNoValue = operator.name === 'is set' || operator.name === 'is missing'

  if (takesNoValue) {
    if (valueText !== '') {
      problems.push({ line, message: `"${operator.name}" does not take a value after it` })
      return undefined
    }
    return { subject, operator, values: [], wrote: rest, line }
  }

  if (valueText === '') {
    problems.push({ line, message: `"${operator.name}" needs a value after it` })
    return undefined
  }

  const raw = operator.list ? listValues(valueText) : (quotedParts(valueText) ?? [valueText])
  if (raw.length === 0) {
    problems.push({ line, message: 'A quote was opened and never closed' })
    return undefined
  }
  if (!operator.list && raw.length > 1) {
    problems.push({ line, message: `"${operator.name}" takes one value; use "in" for a list` })
    return undefined
  }

  const values: (string | number | boolean)[] = []
  for (const item of raw) {
    const coerced = coerce(item, subject)
    if (!coerced.ok) {
      problems.push({ line, message: coerced.message })
      return undefined
    }
    values.push(coerced.value)
  }

  return { subject, operator, values, wrote: rest, line }
}

/**
 * One condition, built from its three parts rather than from a line of text.
 *
 * For the block editor, which has the subject, the comparison and the value as
 * three separate controls and needs the same checking the text form gets —
 * written this way round so there is one set of rules about what a condition
 * may be, not one per editor.
 */
export function readCondition(
  subjectName: string,
  operatorName: string,
  rawValue: string
): { condition?: ScriptCondition; message?: string } {
  const problems: ScriptProblem[] = []
  const text = rawValue.trim() === '' ? `${subjectName} ${operatorName}` : `${subjectName} ${operatorName} ${rawValue}`
  const condition = parseCondition(text, 1, problems)
  return condition ? { condition } : { message: problems[0]?.message ?? 'That is not a condition' }
}

export function parseScript(source: string): ParseResult {
  const problems: ScriptProblem[] = []
  const script: ParsedScript = { name: '', conditions: [], fixes: [], comments: emptyComments() }
  const read = logicalLines(source)
  script.comments.trailing = read.trailing
  let sawReport = false

  for (const { text, line, comments } of read.lines) {
    const match = /^(\S+)\s*(.*)$/.exec(text)
    if (!match) continue
    const directive = match[1].toLowerCase()
    const rest = match[2].trim()

    if (!DIRECTIVES.includes(directive)) {
      problems.push({
        line,
        message: `"${match[1]}" is not something a rule can say. Lines start with ${DIRECTIVES.join(', ')}.`
      })
      continue
    }

    const field = TEXT_DIRECTIVES[directive]
    if (field) {
      if (rest === '') {
        problems.push({ line, message: `"${directive}" needs something after it` })
        continue
      }
      // A quoted value is unwrapped, so both forms read the same.
      const quoted = rest.startsWith('"') ? quotedParts(rest) : undefined
      const value = quoted && quoted.length === 1 ? quoted[0] : rest
      if (field === 'name') script.name = value
      else if (field === 'summary') script.summary = value
      else if (field === 'whatItDoes') script.whatItDoes = value
      else if (field === 'howItWorks') script.howItWorks = value
      else if (field === 'ifDisabled') script.ifDisabled = value
      script.comments[field] = comments
      continue
    }

    if (directive === 'when') {
      const condition = parseCondition(rest, line, problems)
      if (condition) {
        script.conditions.push(condition)
        script.comments.when.push(comments)
      }
      continue
    }

    if (directive === 'report') {
      if (sawReport) {
        problems.push({ line, message: 'A rule reports one thing; there is already a "report" line above' })
        continue
      }
      const severityMatch = /^(\S+)\s*(.*)$/.exec(rest)
      const severity = severityMatch?.[1]?.toLowerCase()
      if (!severityMatch || !severity || !SEVERITIES.includes(severity as ScriptSeverity)) {
        problems.push({ line, message: `"report" needs one of ${SEVERITIES.join(', ')} after it` })
        continue
      }
      const parts = quotedParts(severityMatch[2].trim())
      if (parts === undefined) {
        problems.push({ line, message: 'A quote was opened and never closed' })
        continue
      }
      if (parts.length === 0) {
        problems.push({ line, message: 'A "report" line needs a title in quotes' })
        continue
      }
      if (parts.length > 2) {
        problems.push({ line, message: 'A "report" line takes a title and, at most, one explanation' })
        continue
      }
      sawReport = true
      script.report = { severity: severity as ScriptSeverity, title: parts[0], detail: parts[1] ?? '' }
      script.comments.report = comments
      continue
    }

    // fix
    const fix = fixNamed(rest)
    if (!fix) {
      problems.push({
        line,
        message: `There is no fix called "${rest}". A rule can ask for transcode-video, remux, drop-track or resync-subtitles.`
      })
      continue
    }
    if (script.fixes.includes(fix.name)) {
      problems.push({ line, message: `"${fix.name}" has already been asked for` })
      continue
    }
    script.fixes.push(fix.name)
    script.comments.fix.push(comments)
  }

  /* --- does the whole thing make sense? ------------------------------- */

  if (script.name === '') {
    problems.push({ line: 1, message: 'A rule needs a name: start a line with "name".' })
  }
  if (script.conditions.length === 0) {
    problems.push({
      line: 1,
      message: 'A rule needs at least one "when" line, or it would match every file in the library.'
    })
  }
  if (!script.report && script.fixes.length === 0) {
    problems.push({ line: 1, message: 'A rule has to do something: give it a "report" line, a "fix" line, or both.' })
  }

  // A fix that acts on tracks needs the rule to have matched some.
  const scopes = new Set(script.conditions.map((condition) => condition.subject.scope))
  for (const name of script.fixes) {
    const fix = fixNamed(name)
    if (!fix?.needs) continue
    if (fix.needs.some((scope) => scopes.has(scope))) continue
    const list = fix.needs.join(' or ')
    problems.push({
      line: 1,
      message: `"${name}" acts on the tracks a rule matched, so the rule needs a "when" line about ${list} tracks.`
    })
  }

  return problems.length > 0 ? { problems } : { script, problems }
}
