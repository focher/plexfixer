/**
 * The check that stands between another project's release page and a signed
 * installer. It has to refuse the wrong file, and it has to refuse a source
 * that nobody pinned a checksum for — an unpinned download is the thing this
 * exists to end, and "no checksum, so nothing to compare" must not pass.
 */

import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM helper shared with the build scripts
import { assertChecksum, hashingTap } from '../scripts/lib/checksum.mjs'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('hashingTap', () => {
  it('hashes exactly what passes through, and passes it through unchanged', async () => {
    const { tap, digest } = hashingTap()
    const written: Buffer[] = []
    await pipeline(
      Readable.from([Buffer.from('ffmpeg '), Buffer.from('binary')]),
      tap,
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          written.push(chunk)
          done()
        }
      })
    )

    expect(Buffer.concat(written).toString()).toBe('ffmpeg binary')
    expect(digest()).toBe(sha256('ffmpeg binary'))
  })
})

describe('assertChecksum', () => {
  it('accepts the file that was pinned', () => {
    expect(() => assertChecksum('ffmpeg.zip', sha256('the build'), sha256('the build'))).not.toThrow()
  })

  it('refuses a different file, naming both checksums', () => {
    expect(() => assertChecksum('ffmpeg.zip', sha256('something else'), sha256('the build'))).toThrow(
      new RegExp(`not the file that was pinned[\\s\\S]*${sha256('the build')}[\\s\\S]*${sha256('something else')}`)
    )
  })

  it.each([undefined, '', 'latest', 'abc123'])('refuses a source with %j pinned', (pinned) => {
    expect(() => assertChecksum('ffmpeg.zip', sha256('anything'), pinned)).toThrow(/no SHA-256 pinned/)
  })
})

describe('the pinned sources', () => {
  it('each carry a checksum and none point at a rolling tag', async () => {
    // Read as text: importing the script would run it. This is the rule the
    // script enforces at download time, checked here so that adding a source
    // without a checksum fails a test rather than the next person's build.
    const { readFile } = await import('node:fs/promises')
    const script = await readFile(new URL('../scripts/fetch-ffmpeg.mjs', import.meta.url), 'utf8')

    expect(script).not.toMatch(/releases\/download\/latest/)
    expect(script.match(/^\s+url: /gm)?.length).toBe(script.match(/^\s+sha256: '[0-9a-f]{64}'/gm)?.length)
  })
})
