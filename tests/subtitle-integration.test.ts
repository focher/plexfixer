/**
 * The subtitle work against real ffmpeg.
 *
 * The parts of this feature that are arithmetic are tested against timelines
 * built by hand, which is the right way to test arithmetic. What that cannot
 * check is the one place this code meets something it did not write: the text
 * `silencedetect` prints. A regex against a remembered format is a guess, and a
 * guess that is wrong produces a film with no silence in it anywhere and a
 * timing check that confidently says nothing matches.
 *
 * So this synthesises audio with silence in known places, runs the real filter,
 * and checks that what comes back out is where the silence actually was.
 * Skipped when ffmpeg is not installed.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SILENCE_FILTER, speechIntervals } from '@shared/subtitles/silence.js'
import { buildAudioExtractCommand, WHISPER_SAMPLE_RATE } from '@shared/subtitles/asr.js'
import { buildListenCommand } from '@shared/subtitles/audio.js'
import { formatSrt, parseCues } from '@shared/subtitles/cues.js'
import type { Cue } from '@shared/subtitles/cues.js'

const execFileAsync = promisify(execFile)

function which(binary: string): string | undefined {
  for (const dir of [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (!dir) continue
    if (existsSync(join(dir, binary))) return join(dir, binary)
  }
  return undefined
}

const FFMPEG = which('ffmpeg')
const FFPROBE = which('ffprobe')
const enabled = Boolean(FFMPEG && FFPROBE)

let workDir: string
/** Tone where somebody would be speaking, silence where they would not. */
let tonesPath: string

/** 0–5s tone, 5–10s silence, 10–20s tone, 20–23s silence, 23–30s tone. */
const EXPECTED_SPEECH = [
  { startMs: 0, endMs: 5000 },
  { startMs: 10_000, endMs: 20_000 },
  { startMs: 23_000, endMs: 30_000 }
]

beforeAll(async () => {
  if (!enabled) return
  workDir = await mkdtemp(join(tmpdir(), 'plexfixer-subtitles-'))
  tonesPath = join(workDir, 'tones.mkv')

  await execFileAsync(FFMPEG as string, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-filter_complex',
    [
      'sine=f=440:d=5:r=44100[a]',
      'anullsrc=r=44100:cl=mono:d=5[b]',
      'sine=f=440:d=10:r=44100[c]',
      'anullsrc=r=44100:cl=mono:d=3[d]',
      'sine=f=440:d=7:r=44100[e]',
      '[a][b][c][d][e]concat=n=5:v=0:a=1[out]'
    ].join(';'),
    '-map',
    '[out]',
    '-c:a',
    'libopus',
    tonesPath
  ])
}, 120_000)

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

/** ffmpeg's own stderr from a real run of the filter this app uses. */
async function listen(path: string, streamIndex = 0): Promise<string> {
  try {
    const { stderr } = await execFileAsync(FFMPEG as string, buildListenCommand(path, streamIndex), {
      maxBuffer: 16 * 1024 * 1024
    })
    return stderr
  } catch (error) {
    // A non-zero exit still carries the stderr worth looking at.
    return String((error as { stderr?: string }).stderr ?? '')
  }
}

describe.runIf(enabled)('silencedetect, for real', () => {
  it('prints the lines this app expects it to print', async () => {
    const stderr = await listen(tonesPath)
    // Both halves of the pair, which is what the parser matches on. If ffmpeg
    // ever renames these, this is the test that says so.
    expect(stderr).toMatch(/silence_start:\s*[\d.]+/)
    expect(stderr).toMatch(/silence_end:\s*[\d.]+/)
  }, 60_000)

  it('finds the silence where the silence actually is', async () => {
    const speech = speechIntervals(await listen(tonesPath), 30)
    expect(speech).toHaveLength(EXPECTED_SPEECH.length)
    speech.forEach((interval, index) => {
      // ffmpeg reports the edges a few milliseconds inside the block, which is
      // the filter's window and not an error.
      expect(interval.startMs).toBeCloseTo(EXPECTED_SPEECH[index].startMs, -2)
      expect(interval.endMs).toBeCloseTo(EXPECTED_SPEECH[index].endMs, -2)
    })
  }, 60_000)

  it('is the filter the app actually asks for', () => {
    expect(buildListenCommand('/x.mkv', 2)).toContain(SILENCE_FILTER)
    // And at a log level that lets the filter speak; `error` silences it, which
    // is exactly the bug this whole file exists to catch.
    const args = buildListenCommand('/x.mkv', 2)
    expect(args[args.indexOf('-loglevel') + 1]).toBe('info')
  })
})

describe.runIf(enabled)('the audio Whisper is given', () => {
  it('comes out as 16 kHz mono PCM, whatever went in', async () => {
    const wavPath = join(workDir, 'speech.wav')
    await execFileAsync(FFMPEG as string, buildAudioExtractCommand(tonesPath, 0, wavPath))

    const { stdout } = await execFileAsync(FFPROBE as string, [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels',
      '-of',
      'default=nw=1:nk=1',
      wavPath
    ])
    const [codec, sampleRate, channels] = stdout.trim().split('\n')
    expect(codec).toBe('pcm_s16le')
    expect(Number(sampleRate)).toBe(WHISPER_SAMPLE_RATE)
    expect(Number(channels)).toBe(1)
  }, 60_000)

  it('takes only the window it was asked for', async () => {
    const wavPath = join(workDir, 'window.wav')
    await execFileAsync(
      FFMPEG as string,
      buildAudioExtractCommand(tonesPath, 0, wavPath, { startSeconds: 10, durationSeconds: 5 })
    )
    const { stdout } = await execFileAsync(FFPROBE as string, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      wavPath
    ])
    expect(Number(stdout.trim())).toBeCloseTo(5, 1)
  }, 60_000)
})

describe.runIf(enabled)('a subtitle measured against real audio', () => {
  /**
   * The whole feature, on a file where the right answer is known.
   *
   * Thirty seconds is far too short for `analyseSync` to say anything — it
   * refuses anything under two minutes, and rightly — so this checks the
   * pieces that do apply at this length: that cues written over the tones land
   * on the measured speech, and that cues written over the silence do not.
   */
  it('agrees with cues written over the tones and not with cues over the silence', async () => {
    const speech = speechIntervals(await listen(tonesPath), 30)

    const onSpeech: Cue[] = [
      { startMs: 1000, endMs: 3000, text: 'during the first tone' },
      { startMs: 12_000, endMs: 15_000, text: 'during the second' },
      { startMs: 24_000, endMs: 27_000, text: 'during the third' }
    ]
    const onSilence: Cue[] = [
      { startMs: 6000, endMs: 8000, text: 'during the first silence' },
      { startMs: 21_000, endMs: 22_000, text: 'during the second silence' }
    ]

    const inside = (cue: Cue): boolean =>
      speech.some((span) => span.startMs - 400 <= cue.startMs && span.endMs >= cue.startMs)

    expect(onSpeech.every(inside)).toBe(true)
    expect(onSilence.some(inside)).toBe(false)
  }, 60_000)

  it('round trips a cue list through ffmpeg’s own SRT reader', async () => {
    // The SRT this app writes is read back by ffmpeg, which muxes it into
    // the film, and by this parser. Writing one and having ffmpeg convert it proves the output
    // is SRT as the rest of the world reads it, not merely as this reads it.
    const cues: Cue[] = [
      { startMs: 1000, endMs: 3000, text: 'Пример строки' },
      { startMs: 4500, endMs: 6000, text: '- Yes.\n- No.' }
    ]
    const srtPath = join(workDir, 'written.srt')
    await (await import('node:fs/promises')).writeFile(srtPath, formatSrt(cues), 'utf8')

    const vttPath = join(workDir, 'written.vtt')
    await execFileAsync(FFMPEG as string, ['-y', '-hide_banner', '-loglevel', 'error', '-i', srtPath, vttPath])

    const roundTripped = parseCues(await readFile(vttPath, 'utf8'))
    expect(roundTripped.format).toBe('vtt')
    expect(roundTripped.cues).toEqual(cues)
  }, 60_000)
})
