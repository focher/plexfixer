/**
 * Translating a subtitle, a batch of lines at a time.
 *
 * The naive version — one request per line — is wrong twice over. It is slow
 * and expensive, several hundred round trips for a film; and it translates
 * worse, because a line of dialogue out of context is genuinely ambiguous.
 * Russian drops pronouns and marks gender on the verb, "Вы" and "ты" are both
 * "you" but only one of them is polite, and a two-word line is routinely the
 * second half of the sentence before it. A model shown forty consecutive lines
 * gets all of that right and a model shown one cannot.
 *
 * So: batches, with a few already-translated lines carried in front as context,
 * and every line numbered on the way out and counted on the way back. The
 * counting is the part that matters. A model asked for forty lines will
 * occasionally return thirty-nine — it merges two short lines into one, or
 * decides a line needed no translation and drops it — and a subtitle whose
 * lines have silently shifted by one is far worse than one that failed, because
 * nothing about it looks wrong until you watch it. Every batch is reconciled
 * against the numbers it asked for, and a batch that does not reconcile is
 * retried and then split rather than accepted.
 */

import { languageName } from '../languages.js'
import type { Cue } from './cues.js'

/**
 * How a line is numbered on the wire.
 *
 * Double square brackets because the text on either side of them is arbitrary
 * subtitle dialogue: `-` begins half the lines in any film, `[` begins a sound
 * description, digits and colons look like timestamps, and a pipe is a line
 * break in several subtitle formats. `[[12]]` is rare enough in dialogue to be
 * unambiguous and plain enough that a model reproduces it reliably.
 */
const MARKER = /^\s*\[\[(\d+)\]\]\s?(.*)$/

/**
 * A line break inside one cue, carried through as a character.
 *
 * Subtitles break lines deliberately — two speakers in one cue, most often —
 * and a newline in the middle of the wire format would be indistinguishable
 * from the end of the line. Sending a visible character instead keeps one cue
 * on one line, and a model that drops it costs a line break rather than
 * breaking the parse.
 */
export const LINE_BREAK = '⏎'

export function encodeForWire(text: string): string {
  return text.replace(/\n/g, LINE_BREAK)
}

export function decodeFromWire(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
}

/* ------------------------------------------------------------------ *
 * The instruction
 * ------------------------------------------------------------------ */

/**
 * What the model is told, once, for every batch.
 *
 * Written as instructions about *subtitles* rather than about text. The
 * failure modes being headed off are specific and all of them have been seen:
 * explaining an idiom instead of translating it, expanding a four-word line
 * into a sentence that cannot be read in two seconds, helpfully merging two
 * short exchanges, and answering with a preamble about what it is about to do.
 */
export function translationInstruction(fromLanguage: string, toLanguage: string): string {
  const from = languageName(fromLanguage)
  const to = languageName(toLanguage)
  return [
    `You are translating film subtitles from ${from} to ${to}.`,
    '',
    'Rules, all of which matter more than fluency:',
    `- Output exactly one line per input line, each beginning with the same [[n]] marker it arrived with. Never merge two lines, never split one, never add or drop a line. If a line needs no translation, repeat it.`,
    `- Keep ${LINE_BREAK} exactly where it appears. It is a line break inside a single subtitle.`,
    '- Match the length. A subtitle is read in the time it is on screen, so a short line stays short. Do not explain, expand, or add what the original left implied.',
    '- Keep the register. Formal and familiar address, swearing, slang and bad grammar are all deliberate; translate them as what they are rather than tidying them up.',
    '- Keep markup (<i>, <b>) and speaker dashes exactly as they are.',
    '- Translate an idiom into the equivalent idiom, not into an explanation of it.',
    '- Earlier lines may be given as context. They are there to be read, not translated, and must not appear in your answer.',
    '',
    'Answer with the numbered lines and nothing else — no preamble, no notes, no commentary.'
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * Batching
 * ------------------------------------------------------------------ */

export interface TranslationBatch {
  /** Indexes into the cue list, in order. */
  indexes: number[]
  /** Indexes shown as context, which are not to be translated. */
  context: number[]
}

export interface BatchOptions {
  /** How many lines to ask for at once. */
  size?: number
  /** How many already-translated lines to show in front of them. */
  contextLines?: number
  /** A ceiling on characters per batch, for a model with a small window. */
  maxCharacters?: number
}

/**
 * Cut the cue list into batches.
 *
 * Forty lines is the default because it is roughly two minutes of film: long
 * enough that a scene holds together inside one batch, short enough that a
 * batch which fails to reconcile is cheap to redo, and well inside the output
 * limit of every model worth using. The character ceiling is a second bound for
 * the occasional film that is mostly monologue.
 */
export function planBatches(cues: readonly Cue[], options: BatchOptions = {}): TranslationBatch[] {
  const size = Math.max(1, options.size ?? 40)
  const contextLines = Math.max(0, options.contextLines ?? 4)
  const maxCharacters = options.maxCharacters ?? 6000

  const batches: TranslationBatch[] = []
  let at = 0
  while (at < cues.length) {
    const indexes: number[] = []
    let characters = 0
    while (at < cues.length && indexes.length < size) {
      const length = cues[at].text.length + 8
      if (indexes.length > 0 && characters + length > maxCharacters) break
      indexes.push(at)
      characters += length
      at++
    }
    const first = indexes[0]
    batches.push({
      indexes,
      context: Array.from({ length: Math.min(contextLines, first) }, (_, offset) => first - contextLines + offset).filter(
        (index) => index >= 0
      )
    })
  }
  return batches
}

/**
 * The message for one batch.
 *
 * Context lines are given already translated where they have been, because
 * that is what makes them useful: the model is being shown the voice it has
 * been using, not just what was said.
 */
export function renderBatch(
  cues: readonly Cue[],
  batch: TranslationBatch,
  translated: ReadonlyMap<number, string>
): string {
  const parts: string[] = []

  if (batch.context.length > 0) {
    parts.push('Context — the lines just before these, for reference only. Do not include them in your answer.')
    for (const index of batch.context) {
      const original = encodeForWire(cues[index].text)
      const already = translated.get(index)
      parts.push(already ? `  ${encodeForWire(already)}` : `  ${original}`)
    }
    parts.push('')
  }

  parts.push('Translate these, one line each, keeping the markers:')
  for (const index of batch.indexes) {
    parts.push(`[[${index}]] ${encodeForWire(cues[index].text)}`)
  }

  return parts.join('\n')
}

/** Room for the answer: translations run longer than their originals. */
export function tokenBudget(cues: readonly Cue[], batch: TranslationBatch): number {
  let characters = 0
  for (const index of batch.indexes) characters += cues[index].text.length + 10
  // Four characters to a token is the usual rule, doubled because a
  // translation can be half again as long as its original and a truncated
  // batch is a wasted request.
  return Math.min(16_000, Math.max(1024, Math.ceil((characters / 4) * 2.5)))
}

/* ------------------------------------------------------------------ *
 * Reading it back
 * ------------------------------------------------------------------ */

export interface BatchResult {
  /** What came back, by cue index. */
  lines: Map<number, string>
  /** Indexes that were asked for and did not come back. */
  missing: number[]
  /** Indexes that came back and were never asked for, which means it invented them. */
  unexpected: number[]
}

/**
 * Pull the numbered lines out of an answer.
 *
 * Tolerant of everything except ambiguity. A preamble, a trailing note, blank
 * lines and a fenced code block are all stepped over; a line with no marker
 * directly under a marked one is treated as a continuation of it, which is
 * what a model that kept a real line break produces. A blank line ends the
 * block, which is what separates a second line of dialogue from the model's
 * closing "let me know if you need anything else". What is not tolerated is a line arriving
 * under a number that was not asked for, or a number asked for not arriving —
 * those go back to the caller to retry, because the alternative is a subtitle
 * silently off by one.
 */
export function readBatch(answer: string, batch: TranslationBatch): BatchResult {
  const lines = new Map<number, string>()
  const asked = new Set(batch.indexes)
  const unexpected: number[] = []
  let current: number | undefined

  for (const raw of answer.replace(/\r\n?/g, '\n').split('\n')) {
    const marked = MARKER.exec(raw)
    if (marked) {
      const index = Number(marked[1])
      current = index
      if (!asked.has(index)) {
        if (!unexpected.includes(index)) unexpected.push(index)
        continue
      }
      lines.set(index, marked[2].trim())
      continue
    }

    const trimmed = raw.trim()
    // A blank line closes the block. Without this, a model's sign-off — "Let
    // me know if you need anything else" — is indistinguishable from a second
    // line of the last subtitle, and gets glued onto the end of it.
    if (trimmed === '') {
      current = undefined
      continue
    }
    if (current === undefined || !asked.has(current)) continue
    // A fence is the model formatting its answer, not part of the line.
    if (/^```/.test(trimmed)) continue
    const existing = lines.get(current)
    if (existing !== undefined) lines.set(current, `${existing}\n${trimmed}`)
  }

  // An empty translation is a missing one. A model that answers `[[7]]` with
  // nothing has not translated line 7, and writing an empty cue would silently
  // delete a line of dialogue.
  for (const [index, text] of [...lines]) {
    if (decodeFromWire(text).trim() === '') lines.delete(index)
  }

  return {
    lines,
    missing: batch.indexes.filter((index) => !lines.has(index)),
    unexpected
  }
}

/**
 * The cue list with the translations in it.
 *
 * A cue with no translation keeps its original text rather than being dropped
 * or blanked. That is the right failure: a subtitle with four Russian lines in
 * two hours of English is obviously imperfect and completely usable, where one
 * with four lines missing is quietly wrong, and one with four blank cues looks
 * like a rendering bug.
 */
export function applyTranslation(cues: readonly Cue[], translated: ReadonlyMap<number, string>): Cue[] {
  return cues.map((cue, index) => {
    const line = translated.get(index)
    if (line === undefined) return { ...cue }
    const text = decodeFromWire(line)
    return text === '' ? { ...cue } : { ...cue, text }
  })
}

/** Split a batch that would not reconcile, so a retry asks for less at once. */
export function splitBatch(batch: TranslationBatch): TranslationBatch[] {
  if (batch.indexes.length <= 1) return [batch]
  const middle = Math.ceil(batch.indexes.length / 2)
  return [
    { indexes: batch.indexes.slice(0, middle), context: batch.context },
    { indexes: batch.indexes.slice(middle), context: batch.indexes.slice(Math.max(0, middle - 4), middle) }
  ]
}

/** A batch holding only the lines that did not come back. */
export function batchOfMissing(batch: TranslationBatch, missing: readonly number[]): TranslationBatch {
  return { indexes: [...missing], context: batch.context }
}
