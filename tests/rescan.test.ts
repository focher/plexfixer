import { describe, expect, it } from 'vitest'
import { readRescan, rescanRequest } from '@shared/metadata/rescan.js'
import { isProblem } from '@shared/metadata/providers/types.js'

const RADARR = { url: 'http://nas:7878/', apiKey: 'abc' }
const SONARR = { url: 'http://nas:8989', apiKey: 'abc' }

describe('rescanRequest', () => {
  it('posts the command Radarr documents, with the film it names', () => {
    const request = rescanRequest('radarr', RADARR, 42)
    if (isProblem(request)) throw new Error(request.problem)
    expect(request.url).toBe('http://nas:7878/api/v3/command')
    expect(request.method).toBe('POST')
    expect(request.headers?.['X-Api-Key']).toBe('abc')
    expect(JSON.parse(request.body ?? '{}')).toEqual({ name: 'RescanMovie', movieId: 42 })
  })

  it('posts the series form for Sonarr', () => {
    const request = rescanRequest('sonarr', SONARR, 3)
    if (isProblem(request)) throw new Error(request.problem)
    expect(JSON.parse(request.body ?? '{}')).toEqual({ name: 'RescanSeries', seriesId: 3 })
  })

  it('refuses an id that is not one rather than posting nonsense', () => {
    expect(isProblem(rescanRequest('radarr', RADARR, 0))).toBe(true)
    expect(isProblem(rescanRequest('radarr', RADARR, -1))).toBe(true)
    expect(isProblem(rescanRequest('radarr', RADARR, 1.5))).toBe(true)
    expect(isProblem(rescanRequest('radarr', RADARR, Number.NaN))).toBe(true)
  })

  it('says what is missing when the service is not configured', () => {
    expect(isProblem(rescanRequest('radarr', { apiKey: 'x' }, 1))).toBe(true)
    expect(isProblem(rescanRequest('radarr', { url: 'http://nas:7878' }, 1))).toBe(true)
  })
})

describe('readRescan', () => {
  it('reads an accepted command', () => {
    const read = readRescan({ status: 201, text: JSON.stringify({ id: 9, status: 'queued' }) }, 'radarr')
    if (isProblem(read)) throw new Error(read.problem)
    expect(read).toEqual({ id: 9, status: 'queued' })
  })

  /* A command endpoint that answers 202 with nothing has still accepted it. */
  it('treats an empty success as accepted', () => {
    expect(isProblem(readRescan({ status: 202, text: '' }, 'radarr'))).toBe(false)
  })

  it('reports a rejected key as something to go and fix', () => {
    const read = readRescan({ status: 401 }, 'sonarr')
    expect(isProblem(read) && read.needsLogin).toBe(true)
  })

  /*
   * Worth reporting rather than swallowing: a 404 means the film left the
   * library while the repair was running, which somebody would want to know.
   */
  it('reports a refusal instead of pretending the rescan happened', () => {
    const read = readRescan({ status: 404, text: 'NotFound' }, 'radarr')
    expect(isProblem(read)).toBe(true)
    if (isProblem(read)) expect(read.problem).toContain('404')
  })
})
