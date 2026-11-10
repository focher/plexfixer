/**
 * The one configure flag that decides whether an installer may be distributed
 * at all. 0.1.1 shipped a nonfree build because nothing checked.
 *
 * The fixtures here are NUL-separated strings because that is what a binary
 * actually holds. An earlier version of these tests wrote the configure line
 * into unterminated padding, which let a reader pass that could not cope with
 * either shape real builds come in.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM helper shared with the build scripts
import { licenseOf, readConfiguration } from '../scripts/lib/ffmpeg-license.mjs'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-license-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * A stand-in binary: NUL-terminated strings inside padding, the way a real
 * one carries them. `pad` moves them around in the file.
 */
async function binary(strings: string[], pad = 1024): Promise<string> {
  const path = join(dir, 'ffmpeg')
  const parts = [Buffer.alloc(pad, 0x41)]
  for (const value of strings) parts.push(Buffer.from(`${value}\0`, 'latin1'))
  parts.push(Buffer.alloc(pad, 0x42))
  await writeFile(path, Buffer.concat(parts))
  return path
}

/** The two shapes builds use: marker and flags as one literal, or separate. */
const marked = (flags: string): string[] => [`%sconfiguration: ${flags}`]
const unmarked = (flags: string): string[] => ['%sconfiguration: %s', flags]

describe('licenseOf', () => {
  it('refuses a nonfree build', async () => {
    const path = await binary(marked('--prefix=/opt/ff --enable-gpl --enable-nonfree --enable-libfdk-aac'))
    const result = await licenseOf(path)
    expect(result.redistributable).toBe(false)
    expect(result.reason).toBe('--enable-nonfree')
  })

  it('names the licence of a GPL v3 build', async () => {
    const path = await binary(marked('--prefix=/opt/ff --enable-gpl --enable-version3 --enable-libx264'))
    expect(await licenseOf(path)).toMatchObject({ redistributable: true, license: 'GPL v3 or later' })
  })

  it('names the licence of an LGPL build', async () => {
    const path = await binary(marked('--prefix=/opt/ff --disable-libx264 --enable-version3 --enable-nvenc'))
    expect(await licenseOf(path)).toMatchObject({ redistributable: true, license: 'LGPL v3 or later' })
  })

  it('says so rather than guessing when there is no configure line', async () => {
    const path = await binary(['no configure line here at all'])
    expect(await licenseOf(path)).toEqual({ redistributable: 'unknown' })
  })

  it('finds a configure line that straddles a read boundary', async () => {
    // 4 MB chunks: this one starts just before the seam.
    const path = await binary(marked('--prefix=/opt/ff --enable-gpl --enable-nonfree'), 4 * 1024 * 1024 - 20)
    expect((await licenseOf(path)).redistributable).toBe(false)
  })

  it('reads a build that prints the flags as a separate string', async () => {
    // shaka-project's macOS builds hold the marker and the flags together;
    // martin-riedl's hold them apart. Both have to be readable.
    const path = await binary(unmarked('--prefix=/opt/ff --enable-gpl --enable-version3 --enable-nonfree'))
    expect((await licenseOf(path)).redistributable).toBe(false)
  })

  it('reads a build configured without --prefix', async () => {
    // The first reader anchored on --prefix= and so read nothing at all from
    // shaka-project's builds, which do not pass one.
    const flags = '--pkg-config-flags=--static --enable-libx264 --enable-gpl --enable-version3'
    expect(await readConfiguration(await binary(marked(flags)))).toBe(flags)
  })

  it('does not stop at a quoted value inside the line', async () => {
    // The regex reader stopped at the quote in --extra-version='https://…',
    // returning a prefix that happened to omit --enable-gpl. It reported a
    // GPL build as LGPL; a line cut before --enable-nonfree would have been
    // reported as shippable.
    const flags =
      "--prefix=/out --extra-version='https://www.martin-riedl.de' --enable-version3 --enable-gpl --enable-nonfree"
    expect(await readConfiguration(await binary(unmarked(flags)))).toBe(flags)
    expect((await licenseOf(await binary(unmarked(flags)))).redistributable).toBe(false)
  })

  it('does not mistake an encoder’s help text for a configure line', async () => {
    const path = await binary([
      'Delta qindex mode; --deltaq-mode=1 requires --enable-tpl-model=1',
      '%sconfiguration: %s',
      '--prefix=/opt/ff --enable-gpl --enable-version3'
    ])
    expect(await readConfiguration(path)).toBe('--prefix=/opt/ff --enable-gpl --enable-version3')
  })

  it('refuses a line it cannot see the end of', async () => {
    // Unterminated: the rest of it is not in the file, so no verdict is safe.
    const path = join(dir, 'ffmpeg')
    await writeFile(path, Buffer.from('%sconfiguration: --prefix=/opt/ff --enable-gpl --enable-', 'latin1'))
    expect(await licenseOf(path)).toEqual({ redistributable: 'unknown' })
  })
})
