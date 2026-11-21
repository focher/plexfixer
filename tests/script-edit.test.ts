/**
 * The block editor's hands.
 *
 * Dragging is not the interesting part. These two are: a condition and the
 * comment above it are separate lists that have to move together, and moving
 * an item *down* a list is off by one against moving it up, because taking it
 * out shifts every gap after it. Both are invisible when wrong — the rule still
 * works, it just quietly says something else.
 */

import { describe, expect, it } from 'vitest'
import { parseScript, type ParsedScript } from '@shared/plex/modules/script/parse.js'
import { serializeScript } from '@shared/plex/modules/script/serialize.js'
import {
  addCondition,
  addFix,
  editCondition,
  moveCondition,
  removeCondition,
  removeFix
} from '@shared/plex/modules/script/edit.js'

const SOURCE = `name Three things
# about the codec
when video.codec is divx
# about the container
when container is matroska
# about the channels
when audio.channels above 6
report info "y"
fix remux
`

function script(): ParsedScript {
  const { script: parsed, problems } = parseScript(SOURCE)
  expect(problems).toEqual([])
  return parsed!
}

const subjects = (s: ParsedScript): string[] => s.conditions.map((c) => c.subject.name)
const notes = (s: ParsedScript): string[] => s.comments.when.map((c) => c.join('') || '(none)')

describe('adding a condition', () => {
  it('puts it on the end by default, with no comment of its own', () => {
    const next = addCondition(script(), 'file.extension')
    expect(subjects(next)).toEqual(['video.codec', 'container', 'audio.channels', 'file.extension'])
    expect(next.comments.when).toHaveLength(4)
    expect(next.comments.when[3]).toEqual([])
  })

  it('can go in the middle, pushing the comments along with their conditions', () => {
    const next = addCondition(script(), 'file.extension', 1)
    expect(subjects(next)).toEqual(['video.codec', 'file.extension', 'container', 'audio.channels'])
    expect(notes(next)).toEqual(['# about the codec', '(none)', '# about the container', '# about the channels'])
  })

  it('opens with a comparison that suits the kind of value', () => {
    const text = serializeScript(addCondition(script(), 'audio.channels'))
    expect(text).toContain('when audio.channels at least 0')
    expect(serializeScript(addCondition(script(), 'video.interlaced'))).toContain('when video.interlaced is true')
    expect(serializeScript(addCondition(script(), 'file.extension'))).toContain('when file.extension is ""')
  })

  it('ignores a subject that does not exist', () => {
    const before = script()
    expect(addCondition(before, 'video.nonsense')).toBe(before)
  })

  it('leaves the script it was given alone', () => {
    const before = script()
    addCondition(before, 'file.extension')
    expect(before.conditions).toHaveLength(3)
  })
})

describe('removing a condition', () => {
  it('takes the comment above it away too', () => {
    const next = removeCondition(script(), 1)
    expect(subjects(next)).toEqual(['video.codec', 'audio.channels'])
    expect(notes(next)).toEqual(['# about the codec', '# about the channels'])
  })

  it('ignores an index that is not there', () => {
    const before = script()
    expect(removeCondition(before, 9)).toBe(before)
  })
})

describe('moving a condition', () => {
  it('moves it up, taking its comment with it', () => {
    // The third block dropped onto the first.
    const next = moveCondition(script(), 2, 0)
    expect(subjects(next)).toEqual(['audio.channels', 'video.codec', 'container'])
    expect(notes(next)).toEqual(['# about the channels', '# about the codec', '# about the container'])
  })

  it('moves it down, where the gap has shifted under it', () => {
    // The first block dropped onto the third: it lands *before* that one,
    // which is index 1 once the first has been taken out.
    const next = moveCondition(script(), 0, 2)
    expect(subjects(next)).toEqual(['container', 'video.codec', 'audio.channels'])
    expect(notes(next)).toEqual(['# about the container', '# about the codec', '# about the channels'])
  })

  it('moves it to the end when dropped past the last one', () => {
    const next = moveCondition(script(), 0, 3)
    expect(subjects(next)).toEqual(['container', 'audio.channels', 'video.codec'])
  })

  it('does nothing when dropped where it already is', () => {
    expect(subjects(moveCondition(script(), 1, 1))).toEqual(['video.codec', 'container', 'audio.channels'])
  })

  it('ignores a block that is not there', () => {
    const before = script()
    expect(moveCondition(before, 7, 0)).toBe(before)
  })
})

describe('editing a condition', () => {
  it('changes the comparison and the value, keeping the subject', () => {
    const next = editCondition(script(), 0, 'in', 'divx, xvid')
    expect(next.conditions[0].subject.name).toBe('video.codec')
    expect(next.conditions[0].operator.name).toBe('in')
    expect(next.conditions[0].values).toEqual(['divx', 'xvid'])
  })

  it('refuses a value the subject cannot hold, rather than storing nonsense', () => {
    const before = script()
    const after = editCondition(before, 2, 'above', 'six')
    expect(after).toBe(before)
  })
})

describe('fixes', () => {
  it('adds one, with a place for its comment', () => {
    const next = addFix(script(), 'transcode-video')
    expect(next.fixes).toEqual(['remux', 'transcode-video'])
    expect(next.comments.fix).toHaveLength(2)
  })

  it('will not add the same one twice', () => {
    const before = script()
    expect(addFix(before, 'remux')).toBe(before)
  })

  it('ignores one that does not exist', () => {
    const before = script()
    expect(addFix(before, 'delete-everything')).toBe(before)
  })

  it('removes one', () => {
    expect(removeFix(script(), 0).fixes).toEqual([])
  })
})

describe('after any of it', () => {
  it('the rule still writes out and reads back', () => {
    let next = addCondition(script(), 'file.extension', 0)
    next = moveCondition(next, 0, 3)
    next = removeCondition(next, 1)
    next = addFix(next, 'transcode-video')
    const text = serializeScript(next)
    const again = parseScript(text)
    expect(again.problems).toEqual([])
    expect(again.script?.conditions.map((c) => c.subject.name)).toEqual(
      next.conditions.map((c) => c.subject.name)
    )
  })
})
