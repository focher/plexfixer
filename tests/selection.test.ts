import { describe, expect, it } from 'vitest'
import { pruneSelection } from '@shared/selection.js'

const a1 = { v: 'a1' }
const a2 = { v: 'a2' }
const b1 = { v: 'b1' }

describe('pruneSelection', () => {
  it('drops a changed file the filters now hide', () => {
    const next = pruneSelection(new Set(['a', 'b']), new Map([['a', a1], ['b', b1]]), new Map([['a', a2], ['b', b1]]), new Set(['b']))
    expect([...next]).toEqual(['b'])
  })

  it('keeps a changed file that still passes the filters', () => {
    const selected = new Set(['a'])
    expect(pruneSelection(selected, new Map([['a', a1]]), new Map([['a', a2]]), new Set(['a']))).toBe(selected)
  })

  it('keeps an unchanged file a filter is hiding', () => {
    const selected = new Set(['a'])
    expect(pruneSelection(selected, new Map([['a', a1]]), new Map([['a', a1]]), new Set())).toBe(selected)
  })

  it('treats a file new to the library as changed', () => {
    const next = pruneSelection(new Set(['moved']), new Map(), new Map([['moved', a1]]), new Set())
    expect(next.size).toBe(0)
  })

  it('leaves files missing from the library alone', () => {
    const selected = new Set(['gone'])
    expect(pruneSelection(selected, new Map([['gone', a1]]), new Map(), new Set())).toBe(selected)
  })
})
