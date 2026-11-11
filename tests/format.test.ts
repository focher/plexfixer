import { describe, expect, it } from 'vitest'
import { formatAgo } from '@shared/time.js'

describe('formatAgo', () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0)

  it('rounds down into the largest whole unit', () => {
    expect(formatAgo(now, now)).toBe('just now')
    expect(formatAgo(now - 59_000, now)).toBe('just now')
    expect(formatAgo(now - 60_000, now)).toBe('1 min ago')
    expect(formatAgo(now - 59 * 60_000, now)).toBe('59 min ago')
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(formatAgo(now - 49 * 3_600_000, now)).toBe('2 d ago')
  })

  it('treats a future timestamp as just now and a missing one as unknown', () => {
    expect(formatAgo(now + 5_000, now)).toBe('just now')
    expect(formatAgo(undefined, now)).toBe('—')
  })
})
