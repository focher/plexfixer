/**
 * Re-checking a repaired file: which repairs ask for it, what counts as a
 * flag left behind, and — with real binaries, when they are installed — that
 * a finished job carries the file as the re-check found it.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { setField } from '@shared/plex/catalog/edit.js'
import { probeFile } from '@shared/plex/probe.js'
import { flagsToFix, remainingFlags, repairsUsed, wantsRecheck } from '@shared/plex/recheck.js'
import { RepairRunner } from '@shared/plex/runner.js'
import type { AppSettings, Job } from '@shared/types.js'
import { mainAudio, mkv, mp4, video } from './fixtures.js'
import { localHost } from './node-host.js'

const slowStart = mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: false })
const noRecheck = (id: string): AppSettings => ({
  ...DEFAULT_SETTINGS,
  catalog: setField({}, 'repairs', id, 'recheck', false)
})

describe('which repairs a job used', () => {
  it('are the ones its fixable flags are bound to', () => {
    const result = analyzeFile(slowStart, DEFAULT_SETTINGS)
    expect(flagsToFix(result)).toEqual(['mp4-not-faststart'])
    expect(repairsUsed(result, DEFAULT_SETTINGS)).toEqual(['repair.move-index-to-front'])
  })

  it('leave out flags the plan does not fix', () => {
    const result = analyzeFile(mp4([video({ language: 'eng' })]), DEFAULT_SETTINGS)
    expect(flagsToFix(result)).not.toContain('audio-missing')
  })
})

describe('wantsRecheck', () => {
  it('is on for every repair as shipped', () => {
    expect(wantsRecheck(analyzeFile(slowStart, DEFAULT_SETTINGS), DEFAULT_SETTINGS)).toBe(true)
  })

  it('is off when the only repair used has it switched off', () => {
    const settings = noRecheck('repair.move-index-to-front')
    expect(wantsRecheck(analyzeFile(slowStart, settings), settings)).toBe(false)
  })

  it('stays on when any repair the job used wants it', () => {
    const both = mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'und' })])
    const settings = noRecheck('repair.rewrap-container')
    const result = analyzeFile(both, settings)
    expect(repairsUsed(result, settings).length).toBeGreaterThan(1)
    expect(wantsRecheck(result, settings)).toBe(true)
  })
})

describe('remainingFlags', () => {
  it('names flags the job meant to fix that are still there, and nothing else', () => {
    const before = analyzeFile(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'und' })]), DEFAULT_SETTINGS)
    const fixed = analyzeFile(mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]), DEFAULT_SETTINGS)
    expect(remainingFlags(before, fixed)).toEqual([])

    const halfFixed = analyzeFile(mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'und' })]), DEFAULT_SETTINGS)
    expect(remainingFlags(before, halfFixed)).toContain('language-missing')
    expect(remainingFlags(before, halfFixed)).not.toContain('container-not-mp4')
  })
})

/* ------------------------------------------------------------------ *
 * Through the runner, with real binaries
 * ------------------------------------------------------------------ */

const execFileAsync = promisify(execFile)
const find = (binary: string): string | undefined =>
  [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']
    .filter((dir) => dir && existsSync(join(dir, binary)))
    .map((dir) => join(dir, binary))[0]
const FFMPEG = find('ffmpeg')
const FFPROBE = find('ffprobe')

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-recheck-'))
})
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function indexAtEnd(name: string): Promise<string> {
  const path = join(dir, name)
  await execFileAsync(FFMPEG!, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata:s:v:0', 'language=eng', '-metadata:s:a:0', 'language=eng',
    '-disposition:a:0', 'default',
    '-y', path
  ])
  return path
}

async function repair(path: string, settings: AppSettings): Promise<Job> {
  const probed = await probeFile(path, { ffprobePath: FFPROBE!, host: localHost() })
  const result = analyzeFile(probed, settings)
  let finished: Job | undefined
  const runner = new RepairRunner({ ffmpegPath: FFMPEG!, ffprobePath: FFPROBE! }, 1, (job) => {
    if (job.state === 'done' || job.state === 'failed' || job.state === 'skipped') finished = job
  }, localHost())
  runner.enqueue({ result, settings, mode: 'safe-remux' })
  for (let waited = 0; !finished && waited < 30_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!finished) throw new Error('the repair did not finish')
  return finished
}

describe.runIf(Boolean(FFMPEG && FFPROBE))('a repair with re-check on', () => {
  it('hands back the finished file, with nothing left to fix', { timeout: 60_000 }, async () => {
    const job = await repair(await indexAtEnd('recheck-on.mp4'), DEFAULT_SETTINGS)
    expect(job.state).toBe('done')
    expect(job.rechecked?.faststart).toBe(true)
    expect(job.remaining).toEqual([])
    expect(job.metrics?.phases.map((entry) => entry.phase)).toContain('recheck')
  })

  it('skips the re-check when the repair is set not to', { timeout: 60_000 }, async () => {
    const job = await repair(await indexAtEnd('recheck-off.mp4'), noRecheck('repair.move-index-to-front'))
    expect(job.state).toBe('done')
    expect(job.rechecked).toBeUndefined()
    expect(job.log.map((entry) => entry.text)).toContain('Not re-checking the file: its repairs are set not to')
  })
})
