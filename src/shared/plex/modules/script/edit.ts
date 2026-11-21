/**
 * Changing a rule's structure.
 *
 * The block editor's hands. Kept out of the component because the interesting
 * part is not the dragging — it is that conditions and their comments are two
 * parallel lists that must move together, and that moving an item down a list
 * is off by one against moving it up. Both are easy to get subtly wrong and
 * impossible to notice by looking.
 *
 * Every function returns a new script and changes nothing it was given.
 */

import { readCondition, type ParsedScript, type ScriptComments } from './parse.js'
import { fixNamed, subjectNamed, type Subject } from './vocabulary.js'

/** What a value box starts out holding, written so the parser will accept it. */
export function defaultValueFor(subject: Subject): string {
  if (subject.type === 'number') return '0'
  if (subject.type === 'boolean') return 'true'
  // An explicit pair of quotes: left bare this would read as "no value given",
  // which is not a condition at all rather than a condition with a blank in it.
  return '""'
}

/** The comparison a freshly dropped block opens with. */
export function defaultOperatorFor(subject: Subject): string {
  return subject.type === 'number' ? 'at least' : 'is'
}

function withConditions(
  script: ParsedScript,
  conditions: ParsedScript['conditions'],
  when: ScriptComments['when']
): ParsedScript {
  return { ...script, conditions, comments: { ...script.comments, when } }
}

/** Add a condition about `subjectName`, at `at` or on the end. */
export function addCondition(script: ParsedScript, subjectName: string, at?: number): ParsedScript {
  const subject = subjectNamed(subjectName)
  if (!subject) return script
  const built = readCondition(subject.name, defaultOperatorFor(subject), defaultValueFor(subject))
  if (!built.condition) return script

  const conditions = [...script.conditions]
  const when = [...script.comments.when]
  const index = Math.max(0, Math.min(at ?? conditions.length, conditions.length))
  conditions.splice(index, 0, built.condition)
  when.splice(index, 0, [])
  return withConditions(script, conditions, when)
}

/** Replace one condition's comparison and value, leaving its subject alone. */
export function editCondition(
  script: ParsedScript,
  index: number,
  operatorName: string,
  rawValue: string
): ParsedScript {
  const current = script.conditions[index]
  if (!current) return script
  const built = readCondition(current.subject.name, operatorName, rawValue)
  if (!built.condition) return script
  const conditions = [...script.conditions]
  conditions[index] = built.condition
  return withConditions(script, conditions, script.comments.when)
}

export function removeCondition(script: ParsedScript, index: number): ParsedScript {
  if (!script.conditions[index]) return script
  const conditions = [...script.conditions]
  const when = [...script.comments.when]
  conditions.splice(index, 1)
  when.splice(index, 1)
  return withConditions(script, conditions, when)
}

/**
 * Move a condition to sit *before* the one now at `to`.
 *
 * `to` is a gap between items, not an item: dropping onto the third block means
 * "put it where the third block is". Taking the item out first shifts every
 * later gap down by one, which is the whole of the off-by-one — and why moving
 * down and moving up are not the same sum.
 */
export function moveCondition(script: ParsedScript, from: number, to: number): ParsedScript {
  if (!script.conditions[from]) return script
  const conditions = [...script.conditions]
  const when = [...script.comments.when]
  const [condition] = conditions.splice(from, 1)
  const [comment] = when.splice(from, 1)
  const at = from < to ? to - 1 : to
  const clamped = Math.max(0, Math.min(at, conditions.length))
  conditions.splice(clamped, 0, condition)
  when.splice(clamped, 0, comment ?? [])
  return withConditions(script, conditions, when)
}

export function addFix(script: ParsedScript, name: string): ParsedScript {
  const fix = fixNamed(name)
  if (!fix || script.fixes.includes(fix.name)) return script
  return {
    ...script,
    fixes: [...script.fixes, fix.name],
    comments: { ...script.comments, fix: [...script.comments.fix, []] }
  }
}

export function removeFix(script: ParsedScript, index: number): ParsedScript {
  if (!script.fixes[index]) return script
  const fixes = [...script.fixes]
  const fix = [...script.comments.fix]
  fixes.splice(index, 1)
  fix.splice(index, 1)
  return { ...script, fixes, comments: { ...script.comments, fix } }
}
