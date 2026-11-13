import { describe, expect, it } from 'vitest'
import { TEMPORARY_QUIET_MS, isStaleTemporary, isTemporaryName } from '@shared/temporary.js'

const NOW = 1_800_000_000_000
const OLD = NOW - TEMPORARY_QUIET_MS - 1
const path = '/Movies/Cairo Time (2010)/.plexfixer-6734-Cairo Time (2010).m4v'

describe('repair temporary files', () => {
  it('recognises the name a repair gives, and nothing a person would', () => {
    expect(isTemporaryName(path)).toBe(true)
    expect(isTemporaryName('/Movies/.plexfixer-backups/Cairo Time (2010).m4v')).toBe(false)
    expect(isTemporaryName('/Movies/plexfixer-6734-Movie.m4v')).toBe(false)
    expect(isTemporaryName('/Movies/.plexfixer-notes.m4v')).toBe(false)
  })

  it('removes one left behind long enough ago', () => {
    expect(isStaleTemporary(path, OLD, NOW, new Set())).toBe(true)
  })

  it('leaves one that a running repair owns', () => {
    expect(isStaleTemporary(path, OLD, NOW, new Set([path]))).toBe(false)
  })

  it('leaves one that changed recently, which something may still be writing', () => {
    expect(isStaleTemporary(path, NOW - 60_000, NOW, new Set())).toBe(false)
  })

  it('leaves one whose age cannot be read', () => {
    expect(isStaleTemporary(path, undefined, NOW, new Set())).toBe(false)
  })
})
