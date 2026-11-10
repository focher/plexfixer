/**
 * End-to-end check against real media.
 *
 * Synthesises small files with ffmpeg, probes them, analyses them, runs the
 * generated repair command and re-probes the output to confirm the problems are
 * actually gone. Skipped when ffmpeg is not installed.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { probeFile, hasFaststart } from '../src/main/ffmpeg/probe.js'
import { buildRepairCommand } from '../src/main/jobs/command.js'

const execFileAsync = promisify(execFile)

function which(binary: string): string | undefined {
  for (const dir of [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (!dir) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { existsSync } = require('node:fs') as typeof import('node:fs')
      if (existsSync(join(dir, binary))) return join(dir, binary)
    } catch {
      continue
    }
  }
  return undefined
}

const FFMPEG = which('ffmpeg')
const FFPROBE = which('ffprobe')
const enabled = Boolean(FFMPEG && FFPROBE)

let workDir: string

beforeAll(async () => {
  if (!enabled) return
  workDir = await mkdtemp(join(tmpdir(), 'plexfixer-it-'))
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

/** Build a short test file with the given stream layout. */
async function makeFile(name: string, args: string[]): Promise<string> {
  const output = join(workDir, name)
  await execFileAsync(FFMPEG!, ['-hide_banner', '-loglevel', 'error', ...args, '-y', output], {
    timeout: 120_000
  })
  return output
}

const SOURCES = [
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2'
]

describe.runIf(enabled)('integration: probe + analyze + repair', () => {
  it('reads stream metadata, dispositions and languages back correctly', async () => {
    const path = await makeFile('multi.mkv', [
      ...SOURCES,
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-metadata:s:v:0', 'language=jpn',
      '-metadata:s:a:0', 'language=eng',
      '-metadata:s:a:1', 'language=jpn',
      '-disposition:a:0', 'default',
      '-disposition:a:1', '0'
    ])

    const file = await probeFile(path, { ffprobePath: FFPROBE! })
    expect(file.container).toBe('matroska')

    const video = file.streams.find((s) => s.kind === 'video')
    expect(video?.language).toBe('jpn')
    expect(video?.codec).toBe('h264')

    const audio = file.streams.filter((s) => s.kind === 'audio')
    expect(audio.map((s) => s.language)).toEqual(['eng', 'jpn'])
    expect(audio[0].disposition.default).toBe(true)
    expect(audio[1].disposition.default).toBe(false)
  })

  it('moves the default audio to match the video language and produces a playable MP4', async () => {
    const path = await makeFile('mismatch.mkv', [
      ...SOURCES,
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-metadata:s:v:0', 'language=jpn',
      '-metadata:s:a:0', 'language=eng',
      '-metadata:s:a:1', 'language=jpn',
      '-disposition:a:0', 'default'
    ])

    const file = await probeFile(path, { ffprobePath: FFPROBE! })
    const result = analyzeFile(file, DEFAULT_SETTINGS)

    expect(result.primaryLanguage).toBe('jpn')
    expect(result.findings.map((f) => f.code)).toContain('default-audio-language-mismatch')
    expect(result.plan.requiresTranscode).toBe(false)

    const outputPath = join(workDir, 'mismatch.fixed.mp4')
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath })
    await execFileAsync(FFMPEG!, ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 120_000 })

    const repaired = await probeFile(outputPath, { ffprobePath: FFPROBE! })
    const repairedAudio = repaired.streams.filter((s) => s.kind === 'audio')

    expect(repaired.container).toBe('mp4')
    expect(await hasFaststart(outputPath)).toBe(true)
    expect(repairedAudio).toHaveLength(2)
    // The Japanese track — matching the video's language — is now the default,
    // and the English one no longer claims to be.
    const defaults = repairedAudio.filter((s) => s.disposition.default)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].language).toBe('jpn')

    // Re-analysing the output should find nothing left to fix.
    const reanalysed = analyzeFile(repaired, DEFAULT_SETTINGS)
    expect(reanalysed.plan.strategy).toBe('none')
    expect(reanalysed.verdict).toBe('ok')
  }, 180_000)

  it('detects a trailing moov atom and fixes it with a stream copy', async () => {
    const path = await makeFile('noFaststart.mp4', [
      ...SOURCES.slice(0, 8),
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-metadata:s:v:0', 'language=eng',
      '-metadata:s:a:0', 'language=eng',
      '-disposition:a:0', 'default'
    ])

    expect(await hasFaststart(path)).toBe(false)

    const file = await probeFile(path, { ffprobePath: FFPROBE! })
    const result = analyzeFile(file, DEFAULT_SETTINGS)
    expect(result.findings.map((f) => f.code)).toContain('mp4-not-faststart')
    expect(result.plan.strategy).toBe('remux')

    const outputPath = join(workDir, 'faststart.mp4')
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath })
    await execFileAsync(FFMPEG!, ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 120_000 })

    expect(await hasFaststart(outputPath)).toBe(true)
  }, 180_000)

  it('adds a playable AAC track beside audio no client can decode', async () => {
    const path = await makeFile('flac.mkv', [
      ...SOURCES.slice(0, 8),
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'flac',
      '-metadata:s:v:0', 'language=eng',
      '-metadata:s:a:0', 'language=eng',
      '-disposition:a:0', 'default'
    ])

    const file = await probeFile(path, { ffprobePath: FFPROBE! })
    const result = analyzeFile(file, DEFAULT_SETTINGS)
    expect(result.plan.strategy).toBe('transcode-audio')
    expect(result.plan.addCompatibilityAudio?.sourceStreamIndex).toBe(1)

    // FLAC cannot live in MP4, so the target stays MKV and the original is kept.
    const outputPath = join(workDir, `flac.fixed.${result.plan.targetContainer}`)
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath })
    await execFileAsync(FFMPEG!, ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 120_000 })

    const repaired = await probeFile(outputPath, { ffprobePath: FFPROBE! })
    const codecs = repaired.streams.filter((s) => s.kind === 'audio').map((s) => s.codec)
    expect(codecs).toContain('aac')
    expect(codecs).toContain('flac')

    const defaults = repaired.streams.filter((s) => s.kind === 'audio' && s.disposition.default)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].codec).toBe('aac')
  }, 180_000)

  it('re-encodes 10-bit H.264 down to a direct-playable 8-bit stream', async () => {
    const path = await makeFile('high10.mkv', [
      ...SOURCES.slice(0, 8),
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le',
      '-c:a', 'aac',
      '-metadata:s:v:0', 'language=eng',
      '-metadata:s:a:0', 'language=eng',
      '-disposition:a:0', 'default'
    ])

    const file = await probeFile(path, { ffprobePath: FFPROBE! })
    const video = file.streams.find((s) => s.kind === 'video')
    expect(video?.kind === 'video' && video.bitDepth).toBe(10)

    const result = analyzeFile(file, DEFAULT_SETTINGS)
    expect(result.findings.map((f) => f.code)).toContain('video-high10-profile')
    expect(result.plan.requiresTranscode).toBe(true)

    const outputPath = join(workDir, 'high10.fixed.mp4')
    // No hardware capabilities passed, so this exercises the libx264 fallback.
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath })
    await execFileAsync(FFMPEG!, ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 300_000 })

    const repaired = await probeFile(outputPath, { ffprobePath: FFPROBE! })
    const repairedVideo = repaired.streams.find((s) => s.kind === 'video')
    expect(repairedVideo?.kind === 'video' && repairedVideo.bitDepth).toBe(8)
    expect(analyzeFile(repaired, DEFAULT_SETTINGS).plan.requiresTranscode).toBe(false)
  }, 300_000)
})

describe.runIf(enabled)('integration: embedded cover art', () => {
  /**
   * Regression for a repair that died with
   *   Tag hvc1 incompatible with output codec id '7' (mp4v)
   *   Could not write header (incorrect codec parameters ?)
   * on an HEVC file carrying poster artwork. ffprobe reports artwork as a
   * video stream, so the builder mapped it and the unscoped `-tag:v hvc1`
   * landed on the JPEG too — the MP4 muxer then refused to write a header and
   * every other stream, subtitles included, failed along with it.
   */
  it('repairs an hev1 file with a poster instead of failing to write a header', async () => {
    const hevc = await makeFile('hevcArt-base.mp4', [
      ...SOURCES.slice(0, 8),
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=none',
      '-tag:v', 'hev1', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-metadata:s:v:0', 'language=eng',
      '-metadata:s:a:0', 'language=eng'
    ])
    const poster = await makeFile('poster.jpg', [
      '-f', 'lavfi', '-i', 'color=c=red:size=300x450:duration=1',
      '-frames:v', '1'
    ])
    const path = await makeFile('hevcArt.mp4', [
      '-i', hevc, '-i', poster,
      '-map', '0', '-map', '1', '-c', 'copy', '-tag:v:0', 'hev1',
      '-disposition:v:1', 'attached_pic'
    ])

    const file = await probeFile(path, { ffprobePath: FFPROBE! })
    // The poster really is a video stream as far as the probe is concerned.
    expect(file.streams.filter((s) => s.kind === 'video')).toHaveLength(2)

    const settings = { ...DEFAULT_SETTINGS, allowHevc: true }
    const result = analyzeFile(file, settings)
    // ...but not as far as the analysis is concerned.
    expect(result.findings.some((f) => f.code === 'video-multiple')).toBe(false)
    expect(result.plan.videoCodecTag).toBe('hvc1')

    const outputPath = join(workDir, 'hevcArt.fixed.mp4')
    const { args } = buildRepairCommand({ result, settings, outputPath })
    // This is the call that used to fail outright.
    await execFileAsync(FFMPEG!, ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 120_000 })

    const repaired = await probeFile(outputPath, { ffprobePath: FFPROBE! })
    const video = repaired.streams.filter((s) => s.kind === 'video')
    // Two video streams again: the real one, retagged, and the poster beside it.
    expect(video).toHaveLength(2)

    const real = video.find((s) => !s.disposition.attachedPic)!
    expect(real.codec).toBe('hevc')
    expect((real as { codecTag?: string }).codecTag).toBe('hvc1')

    const art = video.find((s) => s.disposition.attachedPic)!
    expect(art.codec).toBe('mjpeg')

    expect(repaired.streams.filter((s) => s.kind === 'audio')).toHaveLength(1)
    expect(await hasFaststart(outputPath)).toBe(true)
  }, 180_000)
})
