/**
 * ffmpeg's `-progress` stream is the only sign a long remux is alive, and
 * every field in it can be `N/A`. A real 1.5 GB remux reported:
 *
 *   out_time_us=N/A   out_time_ms=N/A   speed=N/A
 *   total_size=184025136   frame=98944
 *
 * The parser required out_time, so it discarded the whole update and the job
 * sat at 0% from start to finish — indistinguishable from a hang.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFfmpeg } from '@shared/plex/ffmpeg-run.js'
import { localHost } from './node-host.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-progress-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const block = (fields: Record<string, string>): string =>
  `${Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\nprogress=continue\n`

/**
 * A stand-in for ffmpeg: a script that ignores every argument and prints a
 * canned progress stream, so the real parser runs against real pipe output.
 */
async function fakeFfmpeg(blocks: string[]): Promise<string> {
  const path = join(dir, 'fake-ffmpeg.sh')
  // A short pause between blocks, so they land in separate reads the way
  // ffmpeg's half-second updates do. Arriving in one chunk is coalesced into
  // a single update, which is correct but not what is under test here.
  const body = blocks
    .map((b, i) => `${i > 0 ? 'sleep 0.15\n' : ''}cat <<'PROGRESS_EOF'\n${b}PROGRESS_EOF`)
    .join('\n')
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

async function collect(
  blocks: string[],
  options: { durationSeconds?: number; expectedBytes?: number } = {}
): Promise<{ fraction: number; bytesWritten?: number; speed?: string }[]> {
  const seen: { fraction: number; bytesWritten?: number; speed?: string }[] = []
  await runFfmpeg({
    ffmpegPath: await fakeFfmpeg(blocks),
    args: [],
    spawn: (command, commandArgs) => localHost().spawnProcess(command, commandArgs),
    onProgress: (p) => seen.push({ fraction: p.fraction, bytesWritten: p.bytesWritten, speed: p.speed }),
    ...options
  })
  // The last entry is the synthetic fraction:1 on clean exit.
  return seen.slice(0, -1)
}

describe('runFfmpeg progress', () => {
  it('still reports movement when the position is N/A', async () => {
    const during = await collect(
      [
        block({ frame: '34992', total_size: '184025136', out_time_ms: 'N/A', speed: 'N/A' }),
        block({ frame: '66502', total_size: '351273008', out_time_ms: 'N/A', speed: 'N/A' })
      ],
      { expectedBytes: 700_000_000 }
    )
    expect(during).toHaveLength(2)
    expect(during[0].bytesWritten).toBe(184025136)
    expect(during[1].fraction).toBeGreaterThan(during[0].fraction)
    expect(during[0].speed).toBeUndefined()
  })

  it('prefers the position when ffmpeg does report it', async () => {
    const during = await collect([block({ out_time_ms: '60000000', total_size: '1', speed: '12.3x' })], {
      durationSeconds: 120,
      expectedBytes: 1_000_000_000
    })
    expect(during[0].fraction).toBeCloseTo(0.5, 3)
    expect(during[0].speed).toBe('12.3x')
  })

  it('reports a block with nothing usable rather than going silent', async () => {
    const during = await collect([block({ out_time_ms: 'N/A', total_size: 'N/A', speed: 'N/A' })])
    expect(during).toHaveLength(1)
    expect(during[0].fraction).toBe(0)
  })
})
