import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, withDefaults } from '@shared/defaults.js'

describe('withDefaults', () => {
  it('fills everything in from nothing', () => {
    expect(withDefaults(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('drops keys that are not settings', () => {
    const merged = withDefaults({ nonsense: 1 } as never)
    expect('nonsense' in merged).toBe(false)
  })

  /*
   * `ensureAacStereo` was a boolean until 0.3.7, when it grew a third answer.
   * Somebody who had turned it off had a reason, and an upgrade that silently
   * turned it back on would start adding tracks to their files.
   */
  describe('the compatible-audio setting, which used to be a boolean', () => {
    it('carries a saved false across as off, not as the new default', () => {
      expect(withDefaults({ ensureAacStereo: false } as never).compatibilityAudio).toBe('off')
    })

    it('carries a saved true across as add', () => {
      expect(withDefaults({ ensureAacStereo: true } as never).compatibilityAudio).toBe('add')
    })

    it('prefers the new setting when a file carries both', () => {
      const merged = withDefaults({ ensureAacStereo: false, compatibilityAudio: 'replace' } as never)
      expect(merged.compatibilityAudio).toBe('replace')
    })

    it('leaves the default alone for a file that has neither', () => {
      expect(withDefaults({}).compatibilityAudio).toBe('add')
    })
  })
})
