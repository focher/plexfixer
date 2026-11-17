/**
 * Which folder a scanned file came from, and what working that out costs.
 *
 * Every file in the library carries the root it was found under, so the folder
 * can be re-scanned later and so a file whose folder is no longer watched can
 * be told from one that is. Working it out means asking whether each scanned
 * path is a file or a folder — which on another machine is a command over the
 * link, and used to be asked again for every single file found.
 */

import { describe, expect, it } from 'vitest'
import { resolveScanRoots, runScan, scanRootOf } from '@shared/plex/scan.js'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import type { HostStat, ProbeHost } from '../src/shared/host.js'

const POSIX = {
  sep: '/',
  join: (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/'),
  dirname: (path: string): string => path.replace(/\/[^/]*$/, '') || '/',
  basename: (path: string): string => path.split('/').pop() ?? '',
  extname: (path: string): string => {
    const dot = (path.split('/').pop() ?? '').lastIndexOf('.')
    return dot > 0 ? (path.split('/').pop() ?? '').slice(dot) : ''
  },
  isAbsolute: (path: string): boolean => path.startsWith('/')
}

/** A host that counts what it is asked, standing in for the far end. */
function countingHost(folders: string[]): ProbeHost & { stats: string[]; execs: number } {
  const stats: string[] = []
  let execs = 0
  return {
    kind: 'remote',
    label: 'nas',
    paths: POSIX as ProbeHost['paths'],
    stats,
    get execs(): number {
      return execs
    },
    async stat(path: string): Promise<HostStat | undefined> {
      stats.push(path)
      return { isDirectory: folders.includes(path), sizeBytes: 1, modifiedMs: 0 }
    },
    async exec(): Promise<string> {
      execs++
      // Not a probe this test cares about; the scan records the error and
      // carries on, which is enough to drive the loop over every file.
      throw new Error('ffprobe not run in this test')
    }
  } as unknown as ProbeHost & { stats: string[]; execs: number }
}

describe('resolveScanRoots', () => {
  it('asks about each scanned path once, and only about those', async () => {
    const host = countingHost(['/media/films'])
    const roots = await resolveScanRoots(['/media/films', '/media/one.mkv'], host)

    expect(host.stats).toEqual(['/media/films', '/media/one.mkv'])
    expect(roots).toEqual([
      { input: '/media/films', root: '/media/films' },
      // A file stands for the folder holding it, so re-scanning that row
      // re-scans the folder rather than the single file.
      { input: '/media/one.mkv', root: '/media' }
    ])
  })

  it('leaves out a path that is not there', async () => {
    const host = countingHost([])
    host.stat = async (): Promise<undefined> => undefined
    expect(await resolveScanRoots(['/gone'], host)).toEqual([])
  })
})

describe('scanRootOf', () => {
  const roots = [
    { input: '/media/films', root: '/media/films' },
    { input: '/media/one.mkv', root: '/media' }
  ]

  it('matches a file to the folder it sits under', () => {
    expect(scanRootOf(roots, '/media/films/Heat (1995)/Heat.mkv', '/')).toBe('/media/films')
  })

  it('matches a path that was named outright', () => {
    expect(scanRootOf(roots, '/media/one.mkv', '/')).toBe('/media')
  })

  it('does not match a folder that merely starts with the same letters', () => {
    // `/media/films-old` is not inside `/media/films`, and a plain prefix test
    // says it is.
    expect(scanRootOf([{ input: '/media/films', root: '/media/films' }], '/media/films-old/x.mkv', '/')).toBeUndefined()
  })

  it('says nothing for a file under none of them', () => {
    expect(scanRootOf(roots, '/elsewhere/x.mkv', '/')).toBeUndefined()
  })
})

describe('what a scan costs the far end', () => {
  it('stats the scanned paths once, however many files are found', async () => {
    // The regression this guards: the root was worked out inside the per-file
    // loop, so a thousand files under one folder meant a thousand `stat`
    // commands over the link, each returning the same answer.
    const host = countingHost(['/media/films'])
    const files = Array.from({ length: 200 }, (_, i) => `/media/films/Film ${i}.mkv`)

    const complete = await runScan({
      scanId: 's1',
      inputPaths: ['/media/films'],
      settings: { ...DEFAULT_SETTINGS, concurrency: 1 },
      host,
      ffprobePath: '/usr/bin/ffprobe',
      findMedia: async () => files,
      signal: new AbortController().signal,
      onProgress: () => undefined
    })

    expect(complete.foundPaths).toHaveLength(200)
    // One per scanned path. Not one per file, and not one per file per path.
    expect(host.stats).toEqual(['/media/films'])
    // Every file was still looked at.
    expect(host.execs).toBe(200)
  })
})
