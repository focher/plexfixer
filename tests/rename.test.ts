/**
 * Applying a naming pattern to a file that needs nothing else.
 *
 * The point of every assertion here is the same one: a new name is a rename,
 * not a copy. The inode is checked rather than the bytes, because identical
 * bytes are exactly what a copy would also produce — only the inode says the
 * file was moved rather than rewritten, and on a multi-gigabyte library over a
 * share that difference is the whole cost of the job.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { probeFile } from '@shared/plex/probe.js'
import { RepairRunner } from '@shared/plex/runner.js'
import { localHost } from './node-host.js'
import type { Host } from './node-host.js'
import type { AppSettings, Job } from '@shared/types.js'
import { mainAudio, mp4, video } from './fixtures.js'

const execFileAsync = promisify(execFile)

function find(binary: string): string | undefined {
  for (const folder of [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (folder && existsSync(join(folder, binary))) return join(folder, binary)
  }
  return undefined
}

const FFMPEG = find('ffmpeg')
const FFPROBE = find('ffprobe')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-rename-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A file that is already everything Plex wants, sitting at a real path. */
async function ready(fileName: string, tags: Record<string, string> = {}): Promise<ReturnType<typeof analyzeFile>> {
  const path = join(dir, fileName)
  await writeFile(path, 'not really an mp4, but the plan never opens it')
  const result = analyzeFile(
    mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { path, fileName, tags }),
    DEFAULT_SETTINGS
  )
  // The premise of every test below: nothing about the file itself is wrong.
  expect(result.plan.strategy).toBe('none')
  return result
}

const inPlace = (patch: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  outputPlacement: 'in-place',
  movieTemplate: '{title} ({year})',
  ...patch
})

/** Run one file through the runner and wait for it to settle. */
async function run(
  result: ReturnType<typeof analyzeFile>,
  settings: AppSettings,
  host: Host = localHost(),
  // Deliberately unrunnable by default: a rename that reached either of these
  // would be copying the file, which is the thing being tested against.
  binaries = { ffmpegPath: 'no-ffmpeg-here', ffprobePath: 'no-ffprobe-here' }
): Promise<Job> {
  let finished: Job | undefined
  const runner = new RepairRunner(binaries, 1, (job) => {
    if (job.state === 'done' || job.state === 'failed' || job.state === 'skipped') finished = job
  }, host)
  const queued = runner.enqueue({ result, settings, mode: 'safe-remux' })
  if (queued.state === 'skipped') return queued
  for (let waited = 0; !finished && waited < 5_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!finished) throw new Error(`the job never finished: ${runner.list()[0]?.stage}`)
  return finished
}

describe('a file that only needs a new name', () => {
  it('is moved, not copied', async () => {
    const result = await ready('The.Thing.1982.1080p.mp4', { title: 'The Thing', date: '1982-06-25' })
    const before = await stat(result.file.path)

    const job = await run(result, inPlace())

    expect(job.state).toBe('done')
    expect(job.outputPath).toBe(join(dir, 'The Thing (1982).mp4'))
    // The same file, under a new name: a copy would have a new inode.
    const after = await stat(job.outputPath)
    expect(after.ino).toBe(before.ino)
    await expect(stat(result.file.path)).rejects.toThrow()
  })

  it('says so, and says nothing was copied', async () => {
    const result = await ready('The.Thing.1982.1080p.mp4', { title: 'The Thing', date: '1982-06-25' })
    const job = await run(result, inPlace())

    expect(job.message).toContain('renamed to The Thing (1982).mp4')
    expect(job.message).toContain('nothing copied')
    expect(job.log[0]?.text).toBe('Queued a rename')
    const renamed = job.log.find((entry) => entry.text === 'Renamed the file')
    expect(renamed?.detail).toContain('The Thing (1982).mp4')
    expect(renamed?.detail).toContain('Nothing was copied')
  })

  it('keeps no backup, because nothing about the file changed', async () => {
    const result = await ready('The.Thing.1982.1080p.mp4', { title: 'The Thing', date: '1982-06-25' })
    const backups: string[] = []
    let finished: Job | undefined
    const runner = new RepairRunner({ ffmpegPath: 'x', ffprobePath: 'x' }, 1, (job) => {
      if (job.state === 'done' || job.state === 'failed') finished = job
    }, localHost())
    runner.onBackup = (record) => backups.push(record.path)
    runner.enqueue({ result, settings: inPlace({ keepBackups: true }), mode: 'safe-remux' })
    for (let waited = 0; !finished && waited < 5_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(finished?.state).toBe('done')
    expect(backups).toEqual([])
  })

  it('leaves a different file sitting at that name alone', async () => {
    const result = await ready('The.Thing.1982.1080p.mp4', { title: 'The Thing', date: '1982-06-25' })
    const occupied = join(dir, 'The Thing (1982).mp4')
    await writeFile(occupied, 'somebody else')

    const job = await run(result, inPlace())

    expect(job.state).toBe('done')
    expect(job.outputPath).toBe(join(dir, 'The Thing (1982) (2).mp4'))
    expect(job.log.some((entry) => entry.level === 'warn' && entry.text.includes('left alone'))).toBe(true)
  })

  it('is still skipped when the pattern produces the name it already has', async () => {
    const result = await ready('The Thing (1982).mp4', { title: 'The Thing', date: '1982-06-25' })
    const job = await run(result, inPlace())

    expect(job.state).toBe('skipped')
    expect(job.message).toBe('Already Plex-ready — nothing to change')
  })

  it('is skipped with no pattern set at all', async () => {
    const result = await ready('The.Thing.1982.1080p.mp4', { title: 'The Thing', date: '1982-06-25' })
    const job = await run(result, inPlace({ movieTemplate: '', episodeTemplate: '' }))

    expect(job.state).toBe('skipped')
  })

  it('is skipped when the output goes somewhere else, because that asks for a second file', async () => {
    for (const placement of ['sibling', 'output-dir'] as const) {
      const result = await ready(`${placement}.The.Thing.1982.mp4`, { title: 'The Thing', date: '1982-06-25' })
      const job = await run(result, inPlace({ outputPlacement: placement, outputDirectory: dir }))

      expect(job.state).toBe('skipped')
      // And the file is where it was.
      expect((await stat(result.file.path)).isFile()).toBe(true)
    }
  })

  it('reports a rename that could not be done, and leaves the file where it is', async () => {
    const result = await ready('The.Thing.1982.1080p.mp4', { title: 'The Thing', date: '1982-06-25' })
    const refuses: Host = {
      ...localHost(),
      async rename() {
        throw new Error('read-only file system')
      }
    }

    const job = await run(result, inPlace(), refuses)

    expect(job.state).toBe('failed')
    expect(job.message).toContain('read-only file system')
    expect(job.log.some((entry) => entry.text.includes('under the name it had'))).toBe(true)
    expect((await stat(result.file.path)).isFile()).toBe(true)
  })

  it('renames a TV episode by its own pattern', async () => {
    const result = await ready('the.wire.s01e03.mp4', {
      show: 'The Wire',
      title: 'The Buys',
      season_number: '1',
      episode_id: '3'
    })
    const job = await run(result, inPlace({ episodeTemplate: '{show} - S{season}E{episode} - {title}' }))

    expect(job.state).toBe('done')
    expect(job.outputPath).toBe(join(dir, 'The Wire - S1E3 - The Buys.mp4'))
  })
})

/**
 * The same thing for a repair that *does* change the file, but only in fields
 * that can be written where they lie. The header edit and the rename are both
 * moves of a few bytes; between them they must not copy the file either.
 */
describe('a header edit that also gets a new name', () => {
  it.skipIf(!FFMPEG || !FFPROBE)(
    'edits the header where it lies and then renames the file',
    { timeout: 60_000 },
    async () => {
      // Index at the front and an untagged audio track: the whole repair is a
      // language tag, which is a fixed-width field in the header.
      const path = join(dir, 'The.Thing.1982.1080p.mp4')
      await execFileAsync(FFMPEG!, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
        '-f', 'lavfi', '-i', 'sine=duration=1',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-metadata:s:v:0', 'language=eng', '-movflags', '+faststart',
        '-y', path
      ])
      const before = await stat(path)

      const probed = await probeFile(path, { ffprobePath: FFPROBE!, host: localHost() })
      const result = analyzeFile({ ...probed, tags: { title: 'The Thing', date: '1982-06-25' } }, DEFAULT_SETTINGS)
      expect(result.plan.strategy).toBe('remux')

      const job = await run(result, inPlace({ keepBackups: false }), localHost(), {
        ffmpegPath: FFMPEG!,
        ffprobePath: FFPROBE!
      })

      expect(job.state).toBe('done')
      expect(job.message).toContain('edited in place')
      expect(job.message).toContain('renamed to The Thing (1982).mp4')
      expect(job.outputPath).toBe(join(dir, 'The Thing (1982).mp4'))
      // One file throughout: edited in place, then moved. Never rewritten.
      expect((await stat(job.outputPath)).ino).toBe(before.ino)
      await expect(stat(path)).rejects.toThrow()
      // And it never fell back to the slow path.
      expect(job.log.some((entry) => entry.text.startsWith('Rewriting the file'))).toBe(false)
    }
  )
})
