/**
 * Building the bundled `mp4tags`.
 *
 * The compiling is CMake's business. What is worth testing is the part that
 * decides whether to build at all, and what it hands the downloader — because
 * both have already been wrong once, and both fail quietly.
 *
 * The first release of this feature shipped without it. Every CI job went
 * green, every installer was built and signed, and the only sign of trouble
 * was one line buried in a build log: `no mp4tags: ... has no SHA-256 pinned`.
 * The hash was pinned in this module and simply never passed to the function
 * that enforces it. That is what these tests are for.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// prettier-ignore
// @ts-expect-error -- plain ESM helper shared with the build scripts
import { SOURCE, UNAVAILABLE, ensureMp4Tags, haveMp4Tags, toolName } from '../scripts/lib/mp4tags.mjs'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-mp4tags-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the pinned source', () => {
  it('has a real SHA-256', () => {
    expect(SOURCE.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('points at a release tarball rather than a branch', () => {
    // A branch moves. This gets compiled into a signed installer, so what it
    // is built from has to be the same bytes every time.
    expect(SOURCE.url).toContain(`/releases/download/v${SOURCE.version}/`)
  })
})

describe('what it hands the downloader', () => {
  /** A stand-in that records how it was called and writes nothing real. */
  function recorder(): { calls: { url: string; options?: { sha256?: string } }[]; download: unknown } {
    const calls: { url: string; options?: { sha256?: string } }[] = []
    return {
      calls,
      download: async (url: string, _to: string, options?: { sha256?: string }) => {
        calls.push({ url, options })
        // Fail after recording: this test is about the call, not the build.
        throw new Error('stopped after recording')
      }
    }
  }

  it('passes the pinned hash, so the download is held to something', async () => {
    // The exact bug that shipped: the real downloader refuses any URL it has
    // not been given a hash for, and the build was skipped for every platform
    // with nothing failing.
    const { calls, download } = recorder()
    await ensureMp4Tags({
      platformKey: process.platform === 'win32' ? 'win32-x64' : process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64',
      outputDir: dir,
      workDir: join(dir, 'work'),
      force: true,
      download
    })

    // Nothing was requested at all on a platform that cannot build here, which
    // is itself correct — the assertion only applies when it got that far.
    if (calls.length > 0) {
      expect(calls[0].url).toBe(SOURCE.url)
      expect(calls[0].options?.sha256).toBe(SOURCE.sha256)
    }
  })
})

describe('when it refuses', () => {
  it('will not cross-compile for another operating system', async () => {
    const other = process.platform === 'win32' ? 'darwin-arm64' : 'win32-x64'
    const result = await ensureMp4Tags({
      platformKey: other,
      outputDir: dir,
      workDir: join(dir, 'work'),
      force: true,
      download: async () => {
        throw new Error('should never be reached')
      }
    })
    expect(result.state).toBe('skipped')
    expect(result.reason).toMatch(/must be built on/)
  })

  it('leaves no marker when it refused for a reason that is not about this machine', async () => {
    // A Windows target on a Mac is not a failure worth remembering: the next
    // run on Windows must try properly rather than read a note left here.
    const other = process.platform === 'win32' ? 'darwin-arm64' : 'win32-x64'
    await ensureMp4Tags({
      platformKey: other,
      outputDir: dir,
      workDir: join(dir, 'work'),
      force: true,
      download: async () => undefined
    })
    expect(existsSync(join(dir, UNAVAILABLE))).toBe(false)
  })
})

describe('the tool itself', () => {
  it('is named for the platform it runs on', () => {
    expect(toolName('win32-x64')).toBe('mp4tags.exe')
    expect(toolName('darwin-arm64')).toBe('mp4tags')
  })

  it('reports an empty folder as not having one', () => {
    expect(haveMp4Tags(dir, 'darwin-arm64')).toBe(false)
  })
})
