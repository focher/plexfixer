/**
 * The one configure flag that decides whether an installer may be distributed
 * at all. 0.1.1 shipped a nonfree build because nothing checked.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM helper shared with the build scripts
import { licenseOf } from '../scripts/lib/ffmpeg-license.mjs'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-license-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A stand-in binary: real ones carry the configure line as a plain string. */
async function binary(configuration: string, pad = 1024): Promise<string> {
  const path = join(dir, 'ffmpeg')
  await writeFile(path, Buffer.concat([Buffer.alloc(pad, 0x41), Buffer.from(configuration, 'latin1'), Buffer.alloc(pad, 0x42)]))
  return path
}

describe('licenseOf', () => {
  it('refuses a nonfree build', async () => {
    const path = await binary('--prefix=/opt/ff --enable-gpl --enable-nonfree --enable-libfdk-aac')
    const result = await licenseOf(path)
    expect(result.redistributable).toBe(false)
    expect(result.reason).toBe('--enable-nonfree')
  })

  it('names the licence of a GPL v3 build', async () => {
    const path = await binary('--prefix=/opt/ff --enable-gpl --enable-version3 --enable-libx264')
    expect(await licenseOf(path)).toMatchObject({ redistributable: true, license: 'GPL v3 or later' })
  })

  it('names the licence of an LGPL build', async () => {
    const path = await binary('--prefix=/opt/ff --disable-libx264 --enable-version3 --enable-nvenc')
    expect(await licenseOf(path)).toMatchObject({ redistributable: true, license: 'LGPL v3 or later' })
  })

  it('says so rather than guessing when there is no configure line', async () => {
    const path = await binary('no configure line here at all')
    expect(await licenseOf(path)).toEqual({ redistributable: 'unknown' })
  })

  it('finds a configure line that straddles a read boundary', async () => {
    // 4 MB chunks with an 8 KB overlap: this one starts just before the seam.
    const path = await binary('--prefix=/opt/ff --enable-gpl --enable-nonfree', 4 * 1024 * 1024 - 20)
    expect((await licenseOf(path)).redistributable).toBe(false)
  })
})
