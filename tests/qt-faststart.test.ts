/**
 * Moving an MP4 index with qt-faststart, end to end through the runner, with
 * real binaries: the one-pass path when the index is the whole repair, the
 * fall back to ffmpeg when qt-faststart fails or declines, and ffmpeg alone
 * when there is anything else to do. Skipped when the binaries are missing.
 */

import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import type { Job } from '@shared/types.js'
import { probeFile } from '@shared/plex/probe.js'
import { RepairRunner, type RunnerBinaries } from '@shared/plex/runner.js'
import { localHost } from './node-host.js'

const execFileAsync = promisify(execFile)

function find(binary: string): string | undefined {
  for (const dir of [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (dir && existsSync(join(dir, binary))) return join(dir, binary)
  }
  return undefined
}

const FFMPEG = find('ffmpeg')
const FFPROBE = find('ffprobe')
const QT_FASTSTART = find('qt-faststart')
const enabled = Boolean(FFMPEG && FFPROBE)

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-qtfs-'))
})
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

/** A short MP4 with its index at the end, which is where ffmpeg puts it by default. */
async function indexAtEnd(name: string, audioLanguage = 'eng'): Promise<string> {
  const path = join(dir, name)
  await execFileAsync(FFMPEG!, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata:s:v:0', 'language=eng', '-metadata:s:a:0', `language=${audioLanguage}`,
    '-disposition:a:0', 'default',
    '-y', path
  ])
  return path
}

/** A stand-in qt-faststart that runs the given shell body. */
async function fakeQt(name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

async function repair(path: string, binaries: Partial<RunnerBinaries>): Promise<Job> {
  const probed = await probeFile(path, { ffprobePath: FFPROBE!, host: localHost() })
  const result = analyzeFile(probed, DEFAULT_SETTINGS)
  let finished: Job | undefined
  const runner = new RepairRunner(
    { ffmpegPath: FFMPEG!, ffprobePath: FFPROBE!, ...binaries },
    1,
    (job) => {
      if (job.state === 'done' || job.state === 'failed' || job.state === 'skipped') finished = job
    },
    localHost()
  )
  runner.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
  for (let waited = 0; !finished && waited < 30_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!finished) throw new Error('the repair did not finish')
  return finished
}

const phases = (job: Job): string[] => job.metrics?.phases.map((entry) => entry.phase) ?? []
const logText = (job: Job): string => job.log.map((entry) => `${entry.text}\n${entry.detail ?? ''}`).join('\n')

describe.runIf(enabled)('moving the MP4 index', () => {
  it.runIf(Boolean(QT_FASTSTART))('uses qt-faststart when the index is the whole repair', { timeout: 60_000 }, async () => {
    const path = await indexAtEnd('only-index.mp4')
    const before = await probeFile(path, { ffprobePath: FFPROBE!, host: localHost() })
    expect(before.faststart).toBe(false)
    expect(analyzeFile(before, DEFAULT_SETTINGS).plan.trackChanges).toEqual([])

    const job = await repair(path, { qtFaststartPath: QT_FASTSTART })
    expect(job.state, logText(job)).toBe('done')
    expect(phases(job)).toContain('qt-faststart')
    expect(phases(job)).not.toContain('ffmpeg')
    expect(job.command?.[0]).toBe(QT_FASTSTART)
    expect(logText(job)).toContain('Moving the index with qt-faststart')

    const after = await probeFile(job.outputPath, { ffprobePath: FFPROBE!, host: localHost() })
    expect(after.faststart).toBe(true)
    expect(after.streams.map((s) => `${s.kind}:${s.codec}`)).toEqual(before.streams.map((s) => `${s.kind}:${s.codec}`))
    expect(Math.abs((after.durationSeconds ?? 0) - (before.durationSeconds ?? 0))).toBeLessThan(0.1)
  })

  it('falls back to ffmpeg when qt-faststart fails', { timeout: 60_000 }, async () => {
    const path = await indexAtEnd('qt-fails.mp4')
    const failing = await fakeQt('qt-fails', 'echo "error reading moov atom" >&2\nexit 1')

    const job = await repair(path, { qtFaststartPath: failing })
    expect(job.state, logText(job)).toBe('done')
    expect(phases(job)).toContain('ffmpeg')
    expect(phases(job)).not.toContain('qt-faststart')
    expect(job.command?.[0]).toBe(FFMPEG)
    const warning = job.log.find((entry) => entry.level === 'warn')
    expect(warning?.text).toContain('using ffmpeg instead')
    expect(warning?.detail).toContain('error reading moov atom')
    expect((await probeFile(job.outputPath, { ffprobePath: FFPROBE!, host: localHost() })).faststart).toBe(true)
  })

  it('falls back to ffmpeg when qt-faststart declines without writing anything', { timeout: 60_000 }, async () => {
    // What the real one does when the last atom is not `moov`: says so, exits 0.
    const path = await indexAtEnd('qt-declines.mp4')
    const declining = await fakeQt('qt-declines', 'echo "last atom in file was not a moov atom"\nexit 0')

    const job = await repair(path, { qtFaststartPath: declining })
    expect(job.state, logText(job)).toBe('done')
    expect(phases(job)).toContain('ffmpeg')
    expect(job.log.find((entry) => entry.level === 'warn')?.detail).toContain('wrote no output')
    expect((await probeFile(job.outputPath, { ffprobePath: FFPROBE!, host: localHost() })).faststart).toBe(true)
  })

  it('leaves the repair to ffmpeg when there is more to it than the index', { timeout: 60_000 }, async () => {
    const path = await indexAtEnd('index-and-language.mp4', 'und')
    const result = analyzeFile(await probeFile(path, { ffprobePath: FFPROBE!, host: localHost() }), DEFAULT_SETTINGS)
    expect(result.plan.trackChanges.length).toBeGreaterThan(0)

    // Would fail the job if it were run at all.
    const never = await fakeQt('qt-never', 'exit 7')
    const job = await repair(path, { qtFaststartPath: never })
    expect(job.state, logText(job)).toBe('done')
    expect(phases(job)).toContain('ffmpeg')
    expect(logText(job)).not.toContain('qt-faststart')
  })
})
