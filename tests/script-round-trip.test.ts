/**
 * Text in, blocks, text out.
 *
 * The block editor rewrites the script from the structure every time something
 * is changed in it, so everything that matters has to survive the trip. These
 * tests are the contract for what "matters" means: every step, every value and
 * every comment — and, just as importantly, that going round twice changes
 * nothing, so an author who switches views repeatedly does not watch their rule
 * drift.
 */

import { describe, expect, it } from 'vitest'
import { parseScript, type ParsedScript } from '@shared/plex/modules/script/parse.js'
import { serializeScript } from '@shared/plex/modules/script/serialize.js'

/** Everything about a rule that is meant to survive, with nothing that is not. */
function shape(script: ParsedScript): unknown {
  return {
    name: script.name,
    summary: script.summary,
    whatItDoes: script.whatItDoes,
    howItWorks: script.howItWorks,
    ifDisabled: script.ifDisabled,
    report: script.report,
    fixes: script.fixes,
    conditions: script.conditions.map((condition) => ({
      subject: condition.subject.name,
      operator: condition.operator.name,
      values: condition.values
    })),
    comments: script.comments
  }
}

function roundTrip(source: string): { before: ParsedScript; after: ParsedScript; text: string } {
  const first = parseScript(source)
  expect(first.problems).toEqual([])
  const text = serializeScript(first.script!)
  const second = parseScript(text)
  expect(second.problems, text).toEqual([])
  return { before: first.script!, after: second.script!, text }
}

const FULL = `# What this rule is for.
name Flag DivX video
summary Finds DivX and Xvid
does It finds the files nothing can play.
how It looks at the video codec.
off DivX files stop being reported.

# Only the really old ones.
when video.codec in divx, dx50, xvid
when container is matroska
when audio.channels above 6
when video.profile is missing

# The important bit.
report blocker "DivX video" "No mainstream client can decode DivX, so the server re-encodes it on every single play, which is the most expensive thing it does."
fix transcode-video
fix remux

# A note at the end.
`

describe('a rule written back out', () => {
  it('keeps every step and every value', () => {
    const { before, after } = roundTrip(FULL)
    expect(shape(after)).toEqual(shape(before))
  })

  it('keeps the comments, attached to the step they sat above', () => {
    const { after, text } = roundTrip(FULL)
    expect(after.comments.name).toEqual(['# What this rule is for.'])
    expect(after.comments.when[0]).toEqual(['# Only the really old ones.'])
    expect(after.comments.when[1]).toEqual([])
    expect(after.comments.report).toEqual(['# The important bit.'])
    expect(after.comments.trailing).toEqual(['# A note at the end.'])
    expect(text).toContain('# Only the really old ones.')
  })

  it('does not drift when it goes round again', () => {
    const once = serializeScript(parseScript(FULL).script!)
    const twice = serializeScript(parseScript(once).script!)
    expect(twice).toBe(once)
  })

  it('wraps a long explanation, and reads it back as one piece', () => {
    const { after, text } = roundTrip(FULL)
    expect(text.split('\n').every((line) => line.length <= 80)).toBe(true)
    expect(after.report?.detail).toBe(
      'No mainstream client can decode DivX, so the server re-encodes it on every single play, which is the most expensive thing it does.'
    )
  })

  it('leaves out the explanations the author never wrote', () => {
    const { text } = roundTrip('name Short\nwhen container is mp4\nfix remux\n')
    expect(text).not.toContain('summary ')
    expect(text).not.toContain('does ')
    expect(text).not.toContain('how ')
  })

  it('keeps a comma inside a value from becoming two values', () => {
    const { after } = roundTrip('name X\nwhen audio.title contains "Smith, John"\nreport info "Found"\n')
    expect(after.conditions[0].values).toEqual(['Smith, John'])
  })

  it('keeps a quote inside a title', () => {
    const { after } = roundTrip('name X\nwhen container is mp4\nreport info "A \\"quoted\\" word"\n')
    expect(after.report?.title).toBe('A "quoted" word')
  })

  it('keeps numbers as numbers and true/false as true/false', () => {
    const { after } = roundTrip(
      'name X\nwhen audio.channels at least 8\nwhen video.interlaced is true\nreport info "y"\n'
    )
    expect(after.conditions[0].values).toEqual([8])
    expect(after.conditions[1].values).toEqual([true])
  })

  it('keeps a comparison that takes no value', () => {
    const { after, text } = roundTrip('name X\nwhen video.profile is set\nreport info "y"\n')
    expect(text).toContain('when video.profile is set')
    expect(after.conditions[0].values).toEqual([])
  })

  it('writes the steps in one order, whatever order they were typed in', () => {
    // The block editor has no way to say "this fix came before that condition",
    // so the text form settles on one order rather than pretending otherwise.
    const jumbled = 'fix remux\nreport info "y"\nwhen container is mp4\nname Backwards\n'
    const { text } = roundTrip(jumbled)
    const order = text
      .split('\n')
      .map((line) => line.split(' ')[0])
      .filter((word) => ['name', 'when', 'report', 'fix'].includes(word))
    expect(order).toEqual(['name', 'when', 'report', 'fix'])
  })
})

describe('a rule still being built', () => {
  it('keeps a value that has not been filled in yet', () => {
    // The block editor drops a condition in with nothing in its value box.
    // Written bare that would read back as a missing value, which would turn a
    // half-built rule into a broken one.
    const { after, text } = roundTrip('name X\nwhen video.codec is ""\nreport info "y"\n')
    expect(text).toContain('when video.codec is ""')
    expect(after.conditions[0].values).toEqual([''])
  })
})
