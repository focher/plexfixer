import { describe, expect, it } from 'vitest'
import { actionableSelection, pruneSelection } from '@shared/selection.js'

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

describe('actionableSelection', () => {
  const inLibrary = (): boolean => true

  it('acts only on the ticks the list is showing', () => {
    // The bug this exists to stop: two files ticked, then a filter that hides
    // both. The screen showed two unticked rows and the toolbar said
    // "2 selected", and Bulk repaired the two films that were not there.
    const picked = new Set(['arrival', 'severance'])
    const onScreen = ['casablanca', 'ghost']
    expect(actionableSelection(picked, onScreen, inLibrary)).toEqual({ paths: [], hidden: 2 })
  })

  it('hands them back in the order the list has them, not the order they were ticked', () => {
    const picked = new Set(['c', 'a'])
    expect(actionableSelection(picked, ['a', 'b', 'c'], inLibrary)).toEqual({ paths: ['a', 'c'], hidden: 0 })
  })

  it('counts the ones a filter is holding back, so the toolbar can say so', () => {
    const picked = new Set(['a', 'b', 'c'])
    expect(actionableSelection(picked, ['a'], inLibrary)).toEqual({ paths: ['a'], hidden: 2 })
  })

  it('does not count a file the library has lost as hidden', () => {
    // A repair that renamed the file, or a scan that no longer finds it: it is
    // gone, and reporting it as "1 hidden" would send the user looking for a
    // row that cannot be shown by widening anything.
    const picked = new Set(['a', 'gone'])
    const known = (path: string): boolean => path !== 'gone'
    expect(actionableSelection(picked, ['a'], known)).toEqual({ paths: ['a'], hidden: 0 })
  })

  it('is empty for an empty selection', () => {
    expect(actionableSelection(new Set(), ['a', 'b'], inLibrary)).toEqual({ paths: [], hidden: 0 })
  })
})
