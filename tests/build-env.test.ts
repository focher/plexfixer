/**
 * The build's credentials file. It is read on the machine that builds the
 * Windows release, where a mistake is quiet: a key that does not load produces
 * a release the updater will not offer, with nothing failing to say so.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM helper shared with the build scripts
import { loadEnv } from '../scripts/lib/env.mjs'

let dir: string
let before: NodeJS.ProcessEnv

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-env-'))
  before = { ...process.env }
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, before)
  await rm(dir, { recursive: true, force: true })
})

/** Write a credentials file into the temporary root and load it. */
async function load(contents: string): Promise<string[]> {
  await writeFile(join(dir, 'plexfixer.env'), contents)
  return loadEnv(dir)
}

describe('loadEnv', () => {
  it('sets the variables in the file', async () => {
    const applied = await load('PLEXFIXER_TEST_KEY=abc123\n')
    expect(applied).toEqual(['PLEXFIXER_TEST_KEY'])
    expect(process.env.PLEXFIXER_TEST_KEY).toBe('abc123')
  })

  it('does nothing when there is no file', () => {
    expect(loadEnv(dir)).toEqual([])
  })

  it('ignores comments and blank lines', async () => {
    const applied = await load('# a note\n\nPLEXFIXER_TEST_KEY=value\n')
    expect(applied).toEqual(['PLEXFIXER_TEST_KEY'])
  })

  it('keeps a value that contains an equals sign', async () => {
    // Base64 is padded with them, and the signing key is base64.
    await load('PLEXFIXER_TEST_KEY=dW50cnVzdGVkIGNvbW1lbnQ=\n')
    expect(process.env.PLEXFIXER_TEST_KEY).toBe('dW50cnVzdGVkIGNvbW1lbnQ=')
  })

  it('strips the quotes around a value that has them', async () => {
    await load('PLEXFIXER_TEST_KEY="Timothy Weaver"\n')
    expect(process.env.PLEXFIXER_TEST_KEY).toBe('Timothy Weaver')
  })

  it('sets an empty value rather than leaving it unset', async () => {
    // The signing key's password is empty. Unset, the Tauri CLI stops to ask
    // for one, so a build that should be unattended hangs instead.
    const applied = await load('PLEXFIXER_TEST_PASSWORD=\n')
    expect(applied).toEqual(['PLEXFIXER_TEST_PASSWORD'])
    expect(process.env.PLEXFIXER_TEST_PASSWORD).toBe('')
  })

  it('survives the CRLF a file copied to Windows comes back with', async () => {
    await load('PLEXFIXER_TEST_KEY=abc123\r\nPLEXFIXER_TEST_OTHER=def\r\n')
    expect(process.env.PLEXFIXER_TEST_KEY).toBe('abc123')
    expect(process.env.PLEXFIXER_TEST_OTHER).toBe('def')
  })

  it('leaves a variable that is already set alone', async () => {
    // CI sets these from its own secrets and has to stay in charge of them.
    process.env.PLEXFIXER_TEST_KEY = 'from the environment'
    const applied = await load('PLEXFIXER_TEST_KEY=from the file\n')
    expect(applied).toEqual([])
    expect(process.env.PLEXFIXER_TEST_KEY).toBe('from the environment')
  })

  it('skips a line that is not an assignment', async () => {
    const applied = await load('nonsense\n=novalue\nPLEXFIXER_TEST_KEY=ok\n')
    expect(applied).toEqual(['PLEXFIXER_TEST_KEY'])
  })

  it('accepts a line written as an export', async () => {
    await load('export PLEXFIXER_TEST_KEY=abc123\n')
    expect(process.env.PLEXFIXER_TEST_KEY).toBe('abc123')
  })
})
