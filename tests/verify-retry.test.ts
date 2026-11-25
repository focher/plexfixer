/**
 * The check that happens after a repair, and what it does when the answer
 * comes back wrong.
 *
 * From a real failure: a 13 GB remux over a network share ran for thirteen
 * minutes, ffmpeg exited cleanly, and the output was discarded because ffprobe
 * — asked a fraction of a second later — could not make sense of it. The size
 * on disk at that moment was 4.77 GB against the 11.5 GB ffmpeg had already
 * reported writing, so what the check actually caught was a share that had not
 * finished flushing, not a bad file.
 *
 * So: ask again before condemning a copy that expensive, and when it really is
 * bad, say which line said so.
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
import { localHost, type Host } from './node-host.js'

const execFileAsync = promisify(execFile)

function find(binary: string): string | undefined {
  for (const dir of [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (dir && existsSync(join(dir, binary))) return join(dir, binary)
  }
  return undefined
}

const FFMPEG = find('ffmpeg')
const FFPROBE = find('ffprobe')
const enabled = Boolean(FFMPEG && FFPROBE)

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-verify-'))
})
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

/** A short MP4 with its index at the end, so there is a real repair to do. */
async function indexAtEnd(name: string): Promise<string> {
  const path = join(dir, name)
  await execFileAsync(FFMPEG!, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata:s:v:0', 'language=eng', '-metadata:s:a:0', 'language=eng',
    '-disposition:a:0', 'default',
    '-y', path
  ])
  return path
}

/**
 * An ffprobe that refuses the repair's temporary file the first `failures`
 * times it is asked about it, in ffprobe's own voice — a decoder's complaint
 * first and the verdict underneath — and otherwise hands the question to the
 * real one.
 */
async function flakyFfprobe(name: string, failures: number): Promise<string> {
  const path = join(dir, name)
  const counter = join(dir, `${name}.count`)
  await writeFile(
    path,
    `#!/bin/sh
case "$*" in
  *.plexfixer-*)
    n=$(cat "${counter}" 2>/dev/null || echo 0)
    n=$((n+1))
    echo "$n" > "${counter}"
    if [ "$n" -le ${failures} ]; then
      echo "[aac @ 000001bbc3e450c0] skip_data_stream_element: Input buffer exhausted before END element found" >&2
      echo "the output: Invalid data found when processing input" >&2
      exit 1
    fi
    ;;
esac
exec "${FFPROBE}" "$@"
`
  )
  await chmod(path, 0o755)
  return path
}

async function repair(path: string, binaries: Partial<RunnerBinaries>, host: Host = localHost()): Promise<Job> {
  const probed = await probeFile(path, { ffprobePath: FFPROBE!, host: localHost() })
  const result = analyzeFile(probed, DEFAULT_SETTINGS)
  let finished: Job | undefined
  const runner = new RepairRunner(
    { ffmpegPath: FFMPEG!, ffprobePath: FFPROBE!, ...binaries },
    1,
    (job) => {
      if (job.state === 'done' || job.state === 'failed' || job.state === 'skipped') finished = job
    },
    host
  )
  runner.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'safe-remux' })
  for (let waited = 0; !finished && waited < 60_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!finished) throw new Error('the repair did not finish')
  return finished
}

const logText = (job: Job): string => job.log.map((entry) => `${entry.text}\n${entry.detail ?? ''}`).join('\n')

describe.runIf(enabled)('checking the output reads back', () => {
  it('asks again rather than throwing away a copy over one refusal', { timeout: 90_000 }, async () => {
    const path = await indexAtEnd('flaky-once.mp4')
    const job = await repair(path, { ffprobePath: await flakyFfprobe('ffprobe-once', 1) })

    expect(job.state, logText(job)).toBe('done')
    expect(logText(job)).toContain('did not read back cleanly')
    expect(logText(job)).toContain('read back cleanly on attempt 2')
    expect((await probeFile(job.outputPath, { ffprobePath: FFPROBE!, host: localHost() })).faststart).toBe(true)
  })

  it('gives up after the retries and leaves the original alone', { timeout: 90_000 }, async () => {
    const path = await indexAtEnd('flaky-always.mp4')
    const job = await repair(path, { ffprobePath: await flakyFfprobe('ffprobe-always', 99) })

    expect(job.state).toBe('failed')
    // The verdict, not the decoder warning printed above it.
    expect(job.message).toContain('Invalid data found when processing input')
    expect(job.message).not.toContain('skip_data_stream_element')
    expect(logText(job)).toContain('the original is untouched')
    // The original is still there and still readable.
    expect(existsSync(path)).toBe(true)
    expect((await probeFile(path, { ffprobePath: FFPROBE!, host: localHost() })).streams.length).toBe(2)
  })

  it('keeps everything the tool printed in the detail', { timeout: 90_000 }, async () => {
    const path = await indexAtEnd('flaky-detail.mp4')
    const job = await repair(path, { ffprobePath: await flakyFfprobe('ffprobe-detail', 99) })

    const failure = job.log.find((entry) => entry.level === 'error' && entry.detail)
    expect(failure?.detail).toContain('skip_data_stream_element')
    expect(failure?.detail).toContain('Invalid data found when processing input')
  })
})

describe.runIf(enabled)('measuring the output a share has not finished writing', () => {
  /**
   * The share answered 4.77 GB about a file ffmpeg had just reported writing
   * 11.5 GB of. The figure went into the report as the output's size, the
   * throughput was worked out from it, and the slow-disk note underneath was
   * reasoned from the same wrong number.
   */
  it('asks again instead of recording a size that contradicts ffmpeg', { timeout: 90_000 }, async () => {
    const path = await indexAtEnd('stale-size.mp4')
    const real = localHost()
    let staleAnswers = 0
    const host: Host = {
      ...real,
      async stat(target: string) {
        const answer = await real.stat(target)
        // Only the repair's own temporary file, and only the first time it is
        // asked about — exactly how a share behind on its flushing behaves.
        if (answer && target.includes('.plexfixer-') && staleAnswers === 0) {
          staleAnswers += 1
          return { ...answer, sizeBytes: Math.floor(answer.sizeBytes / 3) }
        }
        return answer
      }
    }

    const job = await repair(path, {}, host)

    expect(job.state, logText(job)).toBe('done')
    expect(staleAnswers).toBe(1)
    const truth = (await real.stat(job.outputPath))!.sizeBytes
    expect(job.metrics?.outputBytes).toBe(truth)
    // Nothing to warn about: it was asked again and the second answer agreed.
    expect(logText(job)).not.toContain('reports less than ffmpeg says it wrote')
  })
})
