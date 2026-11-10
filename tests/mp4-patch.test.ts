/**
 * In-place metadata editing, checked against real MP4s.
 *
 * These build files with ffmpeg and read the result back with ffprobe, so the
 * box offsets are verified against the thing that actually writes them rather
 * than against my reading of the spec. They skip when ffmpeg is not on PATH.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  applyPatches,
  packLanguage,
  readMp4Tracks,
  revertPatches,
  unpackLanguage,
  type BytePatch
} from '../src/main/jobs/mp4-patch.js'

const run = promisify(execFile)

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version'])
    return true
  } catch {
    return false
  }
}

const available = await hasFfmpeg()
const whenFfmpeg = available ? describe : describe.skip

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-patch-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A small MP4 with three subtitle tracks carrying known language codes. */
async function sample(): Promise<string> {
  const srt = join(dir, 's.srt')
  await writeFile(srt, '1\n00:00:00,000 --> 00:00:02,000\nHi\n\n')
  const path = join(dir, 'sample.mp4')
  await run('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=3',
    '-f', 'lavfi', '-i', 'sine=duration=3',
    '-i', srt, '-i', srt, '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2', '-map', '3', '-map', '4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=ces',
    '-metadata:s:s:1', 'language=deu',
    '-metadata:s:s:2', 'language=eng',
    '-f', 'mp4', '-y', path
  ])
  return path
}

async function probeLanguages(path: string): Promise<string[]> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'stream_tags=language', '-of', 'csv=p=0', path
  ])
  return stdout.trim().split('\n').map((l) => l.trim())
}

describe('language packing', () => {
  it('round-trips a code', () => {
    expect(unpackLanguage(packLanguage('cze')!)).toBe('cze')
    expect(unpackLanguage(packLanguage('und')!)).toBe('und')
  })

  it('matches the value ffmpeg writes', () => {
    // Measured from a real file: ces is 0x0CB3, cze is 0x0F45.
    expect(packLanguage('ces')).toBe(0x0cb3)
    expect(packLanguage('cze')).toBe(0x0f45)
  })

  it('refuses anything that is not three letters', () => {
    expect(packLanguage('en')).toBeUndefined()
    expect(packLanguage('en-US')).toBeUndefined()
    expect(packLanguage('')).toBeUndefined()
  })
})

whenFfmpeg('readMp4Tracks', () => {
  it('lists tracks in the order ffprobe numbers its streams', async () => {
    const tracks = await readMp4Tracks(await sample())
    expect(tracks?.map((t) => t.handler)).toEqual(['vide', 'soun', 'sbtl', 'sbtl', 'sbtl'])
    expect(tracks?.map((t) => t.language)).toEqual(['und', 'und', 'ces', 'deu', 'eng'])
  })

  it('returns nothing for a file that is not an MP4', async () => {
    const path = join(dir, 'not.mp4')
    await writeFile(path, Buffer.alloc(4096, 0x41))
    expect(await readMp4Tracks(path)).toBeUndefined()
  })
})

whenFfmpeg('applyPatches', () => {
  const languagePatch = (offset: number, from: string, to: string): BytePatch => {
    const expected = Buffer.alloc(2)
    expected.writeUInt16BE(packLanguage(from)!)
    const replacement = Buffer.alloc(2)
    replacement.writeUInt16BE(packLanguage(to)!)
    return { offset, expected, replacement, description: `${from} -> ${to}` }
  }

  it('rewrites a language tag without changing anything else', async () => {
    const path = await sample()
    const before = await readFile(path)
    const tracks = (await readMp4Tracks(path))!
    const czech = tracks[2]

    await applyPatches(path, [languagePatch(czech.languageOffset, 'ces', 'cze')])

    expect(await probeLanguages(path)).toEqual(['und', 'und', 'cze', 'deu', 'eng'])

    const after = await readFile(path)
    expect(after.length).toBe(before.length)
    const differing = [...before].reduce((n, byte, i) => (byte === after[i] ? n : n + 1), 0)
    expect(differing).toBe(2)
  })

  it('refuses to write when the file does not hold what was expected', async () => {
    const path = await sample()
    const before = await readFile(path)
    const tracks = (await readMp4Tracks(path))!

    // Claim the Czech track is currently German.
    await expect(applyPatches(path, [languagePatch(tracks[2].languageOffset, 'deu', 'cze')])).rejects.toThrow(
      /does not hold the expected bytes/
    )
    expect(await readFile(path)).toEqual(before)
  })

  it('leaves the file untouched when a later patch in the batch is wrong', async () => {
    const path = await sample()
    const before = await readFile(path)
    const tracks = (await readMp4Tracks(path))!

    await expect(
      applyPatches(path, [
        languagePatch(tracks[2].languageOffset, 'ces', 'cze'),
        languagePatch(tracks[3].languageOffset, 'eng', 'ger') // deu, not eng
      ])
    ).rejects.toThrow(/does not hold the expected bytes/)

    expect(await readFile(path)).toEqual(before)
    expect(await probeLanguages(path)).toEqual(['und', 'und', 'ces', 'deu', 'eng'])
  })

  it('puts the original bytes back on revert', async () => {
    const path = await sample()
    const before = await readFile(path)
    const tracks = (await readMp4Tracks(path))!
    const patches = [languagePatch(tracks[2].languageOffset, 'ces', 'cze')]

    await applyPatches(path, patches)
    expect(await probeLanguages(path)).toEqual(['und', 'und', 'cze', 'deu', 'eng'])

    await revertPatches(path, patches)
    expect(await readFile(path)).toEqual(before)
  })

  it('clears the default flag that ffprobe reports', async () => {
    const path = await sample()
    const tracks = (await readMp4Tracks(path))!
    const audio = tracks[1]
    expect(audio.enabled).toBe(true)

    const handle = await readFile(path)
    const current = handle.readUInt8(audio.enabledFlagOffset)
    await applyPatches(path, [
      {
        offset: audio.enabledFlagOffset,
        expected: Buffer.from([current]),
        replacement: Buffer.from([current & ~0x01]),
        description: 'audio default off'
      }
    ])

    const reread = (await readMp4Tracks(path))!
    expect(reread[1].enabled).toBe(false)
  })
})
