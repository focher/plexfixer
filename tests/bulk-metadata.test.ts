/**
 * Looking a selection up at once.
 *
 * The thing worth testing is which rows arrive ticked. Everything here goes
 * on to rewrite files, so a proposal that is merely plausible has to arrive
 * unticked — a screen that ticks everything is a screen people click through.
 */

import { describe, expect, it } from 'vitest'
import { judge, proposalFrom, searchFor, takenCount } from '@shared/plex/bulk-metadata.js'
import type { TmdbMatch } from '@shared/tmdb.js'
import { mainAudio, mkv, video } from './fixtures.js'

const match = (title: string, year?: string, id = 1): TmdbMatch => ({
  id,
  kind: 'movie',
  title,
  year,
  overview: 'A summary.'
})

const file = (fileName: string) => mkv([video(), mainAudio()], { fileName, path: `/m/${fileName}` })

describe('searchFor', () => {
  it('searches for what the file name says', () => {
    expect(searchFor(file('Casino.Royale.2006.1080p.BluRay.x264.mkv'))).toEqual({
      query: 'Casino Royale',
      year: '2006'
    })
  })
})

describe('judge', () => {
  it('trusts a year that agrees', () => {
    expect(judge('2006', 'Casino Royale', [match('Casino Royale', '2006')])).toEqual({ level: 'good' })
  })

  it('does not trust a year that disagrees', () => {
    const verdict = judge('2006', 'Casino Royale', [match('Casino Royale', '1967')])
    expect(verdict.level).toBe('check')
    expect(verdict.level === 'check' && verdict.why).toContain('1967')
  })

  it('does not trust a title that drifted', () => {
    const verdict = judge('2006', 'Casino Royale', [match('Casino', '2006')])
    expect(verdict.level).toBe('check')
  })

  it('accepts a title the database states more fully', () => {
    // Searching "Blade Runner" and getting "Blade Runner 2049" is a drift;
    // searching "Alien" and getting "Alien" with a subtitle is not.
    expect(judge('1979', 'Alien', [match('Alien', '1979')])).toEqual({ level: 'good' })
    expect(judge('2049', 'Blade Runner 2049', [match('Blade Runner 2049', '2049')])).toEqual({ level: 'good' })
  })

  it('takes a single answer on trust even with no year to check it against', () => {
    expect(judge(undefined, 'Heat', [match('Heat', '1995')])).toEqual({ level: 'good' })
  })

  it('does not trust a tie with no year to break it', () => {
    const verdict = judge(undefined, 'Heat', [match('Heat', '1995', 1), match('Heat', '1995', 2)])
    expect(verdict.level).toBe('check')
  })

  it('says so when there is nothing at all', () => {
    expect(judge('2006', 'Casino Royale', [])).toEqual({ level: 'check', why: 'nothing found' })
  })
})

describe('proposalFrom', () => {
  it('ticks a confident row and nothing else', () => {
    const good = proposalFrom(file('Casino.Royale.2006.mkv'), [match('Casino Royale', '2006')])
    expect(good.take).toBe(true)
    expect(good.match?.title).toBe('Casino Royale')

    const doubtful = proposalFrom(file('Casino.Royale.2006.mkv'), [match('Casino Royale', '1967')])
    expect(doubtful.take).toBe(false)
    expect(doubtful.match).toBeDefined()
  })

  it('keeps the other answers to pick from instead', () => {
    const proposal = proposalFrom(file('Heat.mkv'), [match('Heat', '1995', 1), match('Heat', '1986', 2)])
    expect(proposal.alternatives.map((m) => m.id)).toEqual([1, 2])
  })

  it('says plainly when nothing matched', () => {
    const proposal = proposalFrom(file('Zzzz.2006.mkv'), [])
    expect(proposal.take).toBe(false)
    expect(proposal.match).toBeUndefined()
    expect(proposal.problem).toContain('Nothing on themoviedb.org')
  })

  it('does not search for a file name that gave nothing to search for', () => {
    const proposal = proposalFrom(file('2006.mkv'), [match('Anything', '2006')])
    expect(proposal.take).toBe(false)
    expect(proposal.problem).toContain('Nothing in the file name')
  })

  it('counts only the ticked rows that have something to write', () => {
    const rows = [
      proposalFrom(file('Casino.Royale.2006.mkv'), [match('Casino Royale', '2006')]),
      proposalFrom(file('Zzzz.2006.mkv'), [])
    ]
    expect(takenCount(rows)).toBe(1)
    expect(takenCount(rows.map((row) => ({ ...row, take: true })))).toBe(1)
  })
})
