/**
 * Putting a fetched binary where it belongs.
 *
 * This looks like plumbing and shipped a broken Windows build for as long as
 * dovi_tool has existed. The Windows runner unpacks into a temp directory on
 * `C:` and checks the repository out on `D:`, so a plain `rename` between them
 * fails with EXDEV every single time. `fetch-ffmpeg.mjs` had a helper written
 * for exactly that; `dovi-tool.mjs` was added later and called `rename`
 * directly. It is written never to fail a release, so it reported itself as
 * skipped, the build went green, and dovi_tool.exe was simply not in the
 * installer — which every Dolby Vision profile 7 film then failed for want of.
 *
 * So the helper is tested on its own, and the fetchers are held to using it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * How `rename` behaves for this test.
 *
 * EXDEV cannot be provoked portably — it needs two real volumes — so the one
 * call the helper leans on is made to fail the way the Windows runner's does.
 */
const renames = vi.hoisted(() => ({ failWith: undefined as string | undefined, calls: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    default: real,
    rename: async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => {
      renames.calls += 1
      if (renames.failWith) {
        throw Object.assign(new Error(`${renames.failWith}: provoked for the test`), { code: renames.failWith })
      }
      return real.rename(from, to)
    }
  }
})

const { mkdtemp, readFile, rm, stat, writeFile } = await import('node:fs/promises')
// @ts-expect-error -- plain ESM helper shared with the build scripts
const { move } = (await import('../scripts/lib/move.mjs')) as {
  move: (from: string, to: string) => Promise<void>
}

const root = fileURLToPath(new URL('..', import.meta.url))

beforeEach(() => {
  renames.failWith = undefined
  renames.calls = 0
})

async function inATempDirectory(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'plexfixer-move-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('moving a fetched file into place', () => {
  it('puts the file where it was asked to', async () => {
    await inATempDirectory(async (dir) => {
      const from = join(dir, 'source.bin')
      const to = join(dir, 'destination.bin')
      await writeFile(from, 'the binary')
      await move(from, to)
      expect(await readFile(to, 'utf8')).toBe('the binary')
      await expect(stat(from)).rejects.toThrow()
    })
  })

  it('falls back to a copy when the two ends are on different volumes', async () => {
    await inATempDirectory(async (dir) => {
      renames.failWith = 'EXDEV'
      const from = join(dir, 'source.bin')
      const to = join(dir, 'destination.bin')
      await writeFile(from, 'dovi_tool')
      await move(from, to)
      expect(await readFile(to, 'utf8')).toBe('dovi_tool')
      // Asked once and no more: EXDEV never becomes true by waiting.
      expect(renames.calls).toBe(1)
    })
  })

  it('waits out a scanner holding the file open, then copies anyway', async () => {
    await inATempDirectory(async (dir) => {
      renames.failWith = 'EPERM'
      const from = join(dir, 'source.bin')
      const to = join(dir, 'destination.bin')
      await writeFile(from, 'ffmpeg.exe')
      await move(from, to)
      expect(await readFile(to, 'utf8')).toBe('ffmpeg.exe')
      // Unlike EXDEV, this one is worth retrying — a virus scan ends.
      expect(renames.calls).toBeGreaterThan(1)
    })
  }, 20_000)

  it('does not swallow a failure that means something else', async () => {
    await inATempDirectory(async (dir) => {
      renames.failWith = 'ENOSPC'
      await writeFile(join(dir, 'source.bin'), 'x')
      await expect(move(join(dir, 'source.bin'), join(dir, 'destination.bin'))).rejects.toThrow('ENOSPC')
    })
  })
})

describe('the fetchers all use it', () => {
  it('leaves no bare rename in the scripts that place a downloaded binary', async () => {
    for (const file of ['scripts/fetch-ffmpeg.mjs', 'scripts/lib/dovi-tool.mjs']) {
      const source = await readFile(join(root, file), 'utf8')
      expect(source, `${file} should move files with the shared helper`).not.toMatch(/\brename\s*\(/)
      expect(source, `${file} should import the shared helper`).toContain("move.mjs'")
    }
  })
})
