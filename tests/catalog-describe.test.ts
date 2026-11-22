/** The status editor says each rule back in English; the shipped ones should read as they mean. */

import { describe, expect, it } from 'vitest'
import { describeMatch } from '@shared/plex/catalog/describe.js'
import { DEFAULT_CATALOG } from '@shared/plex/catalog/resolve.js'

const say = (index: number): string => describeMatch(DEFAULT_CATALOG.statusRules[index]!.when, DEFAULT_CATALOG)

describe('describeMatch', () => {
  it('says the shipped rules plainly', () => {
    expect(say(0)).toBe('it has no warning or blocker flag')
    expect(say(1)).toBe('it has a blocker flag that the plan does not fix or a warning flag that needs a person that the plan does not fix')
    expect(say(2)).toBe('the plan is a video re-encode')
    expect(say(3)).toBe('not (the plan is nothing to do)')
    expect(say(4)).toBe('always')
  })

  it('names flags by their chip text', () => {
    expect(describeMatch({ any: [{ flag: ['mp4-not-faststart', 'container-not-mp4'] }] }, DEFAULT_CATALOG)).toBe(
      'it has a “Index at end or Not MP4” flag'
    )
  })

  it('combines conditions', () => {
    expect(describeMatch({ and: [{ strategy: ['remux'] }, { always: true }] }, DEFAULT_CATALOG)).toBe(
      '(the plan is a remux) and (always)'
    )
  })
})
