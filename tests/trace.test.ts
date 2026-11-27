/**
 * The running account of what the app did.
 *
 * Two things matter here and the rest is formatting. A call that starts and
 * never comes back has to show up — that is the whole reason this exists, and
 * a log that only records completions would show a silence instead. And no
 * credential may ever reach it, because the report is written to be pasted
 * into a bug thread by someone who will not read it first.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  begin,
  clearTrace,
  redact,
  safeUrl,
  setFact,
  shortRef,
  timed,
  trace,
  traceDropped,
  traceEntries,
  traceInFlight,
  traceReport,
  traceTotals
} from '../src/shared/trace.js'

beforeEach(() => clearTrace())

describe('what is written down', () => {
  it('keeps what happened, in order', () => {
    trace('queue', 'added')
    trace('job', 'started')
    expect(traceEntries().map((entry) => entry.text)).toEqual(['added', 'started'])
  })

  it('forgets the oldest entries rather than growing without limit', () => {
    for (let i = 0; i < 5000; i += 1) trace('ipc', `call ${i}`)
    expect(traceEntries().length).toBeLessThanOrEqual(4000)
    expect(traceDropped()).toBeGreaterThan(0)
    // The newest is still there: it is the old end that goes.
    expect(traceEntries().at(-1)?.text).toBe('call 4999')
  })

  it('says how many it forgot, so a truncated report does not look complete', () => {
    for (let i = 0; i < 5000; i += 1) trace('ipc', `call ${i}`)
    const report = traceReport().join('\n')
    expect(report).toMatch(/older ones forgotten/)
  })
})

describe('a call that has not come back', () => {
  it('appears while it is still running', () => {
    begin('ipc', 'host_read_range /Volumes/media/film.mp4')
    expect(traceInFlight()).toHaveLength(1)
    expect(traceInFlight()[0]?.text).toContain('host_read_range')
  })

  it('stops appearing once it finishes', () => {
    const done = begin('ipc', 'host_stat')
    done()
    expect(traceInFlight()).toHaveLength(0)
  })

  it('is the first thing the report says', () => {
    begin('job', 'checking whether the header can be edited in place', { ref: 'abc' })
    const report = traceReport()
    const flight = report.findIndex((line) => line.includes('Started and not finished'))
    const history = report.findIndex((line) => line.startsWith('Activity ('))
    expect(flight).toBeGreaterThanOrEqual(0)
    expect(flight).toBeLessThan(history)
    // Named in the section about what has not come back, not merely somewhere
    // in the thousand lines of history below it.
    const unfinished = report.slice(flight, history).join('\n')
    expect(unfinished).toContain('checking whether the header can be edited in place')
    expect(unfinished).toContain('[abc]')
  })

  it('says so plainly when everything came back', () => {
    const done = begin('ipc', 'host_stat')
    done()
    expect(traceReport().join('\n')).toContain('every call came back')
  })

  it('writes a start and an end, so a hang leaves a start behind', () => {
    const done = begin('ipc', 'host_read_range')
    expect(traceEntries().map((entry) => entry.text)).toEqual(['host_read_range …'])
    done()
    expect(traceEntries().map((entry) => entry.text)).toEqual(['host_read_range …', 'host_read_range'])
  })

  it('leaves out the start of a call that happens constantly, but still times it', () => {
    const done = begin('ipc', 'host_stat', { quiet: true })
    expect(traceEntries()).toHaveLength(0)
    // Still in flight, which is what matters when one of them wedges.
    expect(traceInFlight()).toHaveLength(1)
    done()
    expect(traceEntries().map((entry) => entry.text)).toEqual(['host_stat'])
    expect(traceEntries()[0]?.ms).toBeGreaterThanOrEqual(0)
  })

  it('records a failure as one, with the reason', async () => {
    await expect(
      timed('ipc', 'host_rename', () => Promise.reject(new Error('Permission denied')))
    ).rejects.toThrow('Permission denied')
    const last = traceEntries().at(-1)
    expect(last?.outcome).toBe('failed')
    expect(last?.detail).toBe('Permission denied')
  })

  it('does not end a call twice', () => {
    const done = begin('ipc', 'host_stat')
    done()
    done()
    expect(traceEntries().filter((entry) => entry.text === 'host_stat')).toHaveLength(1)
  })
})

describe('nothing secret reaches the clipboard', () => {
  it('hides anything that could be a credential, by the name of the field', () => {
    expect(redact('apiKey', 'abc123')).toBe('(hidden)')
    expect(redact('tmdbCredential', 'abc123')).toBe('(hidden)')
    expect(redact('Authorization', 'Bearer x')).toBe('(hidden)')
    expect(redact('password', 'hunter2')).toBe('(hidden)')
  })

  it('says a credential is unset rather than hiding nothing', () => {
    expect(redact('apiKey', '')).toBe('(unset)')
  })

  it('keeps ordinary values, which are the point', () => {
    expect(redact('path', '/Volumes/media/Films/Dune (2021).mkv')).toBe('/Volumes/media/Films/Dune (2021).mkv')
    expect(redact('offset', 4096)).toBe('4096')
  })

  it('throws away a query string, because that is where a key is passed', () => {
    expect(safeUrl('https://api.themoviedb.org/3/search/movie?api_key=secret&query=Dune')).toBe(
      'https://api.themoviedb.org/3/search/movie?…'
    )
    expect(safeUrl('http://192.168.1.4:7878/api/v3/movie')).toBe('http://192.168.1.4:7878/api/v3/movie')
  })
})

describe('reading the report', () => {
  it('puts the state of the queue at the top', () => {
    setFact('queue', '1 of 3 running, 5 waiting')
    expect(traceReport().join('\n')).toContain('1 of 3 running, 5 waiting')
  })

  it('shortens a job id to something that fits on a line', () => {
    expect(shortRef('0f9d2c71-3c2a-4a7e-9d1b-9a0d3a7f1c22')).toBe('0f9d2c71')
    expect(shortRef('short')).toBe('short')
  })

  it('totals up the calls, so a thousand slow reads read as one problem', () => {
    for (let i = 0; i < 3; i += 1) trace('ipc', 'host_read_range /a/b', { ms: 100 })
    trace('ipc', 'host_stat /a/b', { ms: 5 })
    const totals = traceTotals().join('\n')
    expect(totals).toContain('ipc host_read_range')
    // Three of them, 300ms between them, and ahead of the single quick stat.
    expect(totals.indexOf('host_read_range')).toBeLessThan(totals.indexOf('host_stat'))
    expect(totals).toMatch(/host_read_range\s+3/)
  })
})
