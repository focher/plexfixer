import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { isBlocked } from '@shared/plex/blocked.js'
import type { AppSettings, EncoderCapabilities } from '@shared/types.js'
import { buildRepairCommand } from '@shared/plex/command.js'
import { mainAudio, mkv, mp4, video } from './fixtures.js'

const OUT = '/out/Example (2020).mp4'

const CONVERT: AppSettings = { ...DEFAULT_SETTINGS, dolbyVision5: 'hdr10' }

const CAPS: EncoderCapabilities = {
  platform: 'linux',
  available: [],
  nvenc: false,
  videotoolbox: false,
  qsv: false,
  amf: false,
  libplacebo: true
}

function profile(dolbyVisionProfile: number, bitDepth = 10) {
  return mp4([
    video({ codec: 'hevc', codecTag: 'dvh1', profile: 'Main 10', bitDepth, pixFmt: 'yuv420p10le', isHdr: true, dolbyVisionProfile }),
    mainAudio({ index: 1, codec: 'aac' })
  ])
}

/** The value of the option immediately following `flag`. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function filterGraph(args: string[]): string {
  const index = args.findIndex((arg) => arg === '-vf' || arg.startsWith('-filter:v'))
  return index >= 0 ? (args[index + 1] ?? '') : ''
}

describe('Dolby Vision profile 5, left alone', () => {
  const result = analyzeFile(profile(5), DEFAULT_SETTINGS)

  it('is reported and blocked, with nothing re-encoded behind the user’s back', () => {
    const finding = result.findings.find((f) => f.code === 'video-dolby-vision-profile')
    expect(finding?.severity).toBe('blocker')
    expect(finding?.remedy).toBe('manual')
    expect(isBlocked(result)).toBe(true)
    expect(result.plan.videoTranscode).toBeUndefined()
  })

  it('says where the conversion is, so the finding is not a dead end', () => {
    const finding = result.findings.find((f) => f.code === 'video-dolby-vision-profile')
    expect(finding?.detail).toContain('HDR10')
  })
})

describe('Dolby Vision profile 5, set to convert', () => {
  const result = analyzeFile(profile(5), CONVERT)

  it('becomes a re-encode the plan can actually carry out', () => {
    const finding = result.findings.find((f) => f.code === 'video-dolby-vision-profile')
    expect(finding?.remedy).toBe('transcode')
    expect(result.plan.strategy).toBe('transcode-video')
    expect(result.plan.videoTranscode?.dolbyVisionToHdr10).toBe(true)
  })

  it('keeps 10-bit HEVC whatever the transcode codec says, because HDR10 needs it', () => {
    const asH264 = analyzeFile(profile(5), { ...CONVERT, transcodeVideoCodec: 'h264' })
    expect(asH264.plan.videoTranscode?.codec).toBe('hevc')
    // Flattening to 8-bit 4:2:0 would throw away the thing being converted.
    expect(asH264.plan.videoTranscode?.forceYuv420p).toBe(false)
  })

  it('says in the plan that Dolby Vision is being given up', () => {
    const action = result.plan.actions.find((a) => a.label.includes('Dolby Vision'))
    expect(action).toBeDefined()
    expect(action?.detail).toContain('not carried over')
  })

  it('leaves profile 7 alone — its problem is an enhancement layer, not the base', () => {
    const seven = analyzeFile(profile(7), CONVERT)
    const finding = seven.findings.find((f) => f.code === 'video-dolby-vision-profile')
    expect(finding?.remedy).toBe('manual')
    expect(seven.plan.videoTranscode).toBeUndefined()
  })
})

describe('the command for a profile 5 conversion', () => {
  const result = analyzeFile(profile(5), CONVERT)

  it('runs the picture through libplacebo with the RPU applied', () => {
    const { args } = buildRepairCommand({ result, settings: CONVERT, caps: CAPS, outputPath: OUT })
    const graph = filterGraph(args)
    expect(graph).toContain('libplacebo')
    expect(graph).toContain('apply_dolbyvision=true')
    expect(graph).toContain('color_trc=smpte2084')
    expect(graph).toContain('format=yuv420p10le')
  })

  it('asks for the Vulkan device before the input, where a global option belongs', () => {
    const { args } = buildRepairCommand({ result, settings: CONVERT, caps: CAPS, outputPath: OUT })
    expect(args.indexOf('-init_hw_device')).toBeGreaterThanOrEqual(0)
    expect(args.indexOf('-init_hw_device')).toBeLessThan(args.indexOf('-i'))
    expect(valueAfter(args, '-filter_hw_device')).toBe('plexfixer')
  })

  it('tags the output BT.2020 PQ, or players show HDR10 as washed-out SDR', () => {
    const { args } = buildRepairCommand({ result, settings: CONVERT, caps: CAPS, outputPath: OUT })
    expect(valueAfter(args, '-color_primaries')).toBe('bt2020')
    expect(valueAfter(args, '-color_trc')).toBe('smpte2084')
    expect(valueAfter(args, '-colorspace')).toBe('bt2020nc')
  })

  it('refuses rather than quietly re-encoding without the filter', () => {
    expect(() =>
      buildRepairCommand({
        result,
        settings: CONVERT,
        caps: { ...CAPS, libplacebo: false },
        outputPath: OUT
      })
    ).toThrow(/libplacebo/)
  })

  it('leaves an ordinary re-encode untouched', () => {
    const plain = analyzeFile(
      mp4([video({ profile: 'High 10', bitDepth: 10 }), mainAudio({ index: 1, codec: 'aac' })]),
      CONVERT
    )
    const { args } = buildRepairCommand({ result: plain, settings: CONVERT, caps: CAPS, outputPath: OUT })
    expect(args).not.toContain('-init_hw_device')
    expect(filterGraph(args)).not.toContain('libplacebo')
  })
})

/* ------------------------------------------------------------------ *
 * Profile 7 — converted to 8.1 rather than re-encoded
 * ------------------------------------------------------------------ */

const TO_81: AppSettings = { ...DEFAULT_SETTINGS, dolbyVision7: 'profile8' }

/** Profile 7, with a frame rate, in the MKV a disc rip actually arrives as. */
function profile7(frameRate = 23.976) {
  return mkv([
    video({
      codec: 'hevc',
      profile: 'Main 10',
      bitDepth: 10,
      pixFmt: 'yuv420p10le',
      isHdr: true,
      dolbyVisionProfile: 7,
      frameRate
    }),
    mainAudio({ index: 1, codec: 'aac' })
  ])
}

/** Every `-map` target in order. */
function maps(args: string[]): string[] {
  return args.flatMap((arg, index) => (arg === '-map' ? [args[index + 1]] : []))
}

describe('Dolby Vision profile 7', () => {
  it('is reported and left alone while the setting is off', () => {
    const result = analyzeFile(profile7(), DEFAULT_SETTINGS)
    expect(result.plan.dolbyVision7To81).toBeUndefined()
    expect(isBlocked(result)).toBe(true)
  })

  it('plans a conversion, not a re-encode, when the setting is on', () => {
    const result = analyzeFile(profile7(), TO_81)
    expect(result.plan.dolbyVision7To81).toEqual({ sourceStreamIndex: 0, frameRate: 23.976 })
    // The whole point: the picture is copied through.
    expect(result.plan.videoTranscode).toBeUndefined()
    expect(result.plan.requiresTranscode).toBe(false)
    expect(result.plan.strategy).toBe('remux')
    expect(result.plan.unresolved.map((f) => f.code)).not.toContain('video-dolby-vision-profile')
  })

  /*
   * The stream comes back as raw HEVC, which carries no timing. Muxed without
   * a stated rate, ffmpeg assumes 25 and a 23.976 film runs four per cent fast
   * — in step at the opening credits and a minute adrift by the end.
   */
  it('states the frame rate on the converted input, before the input it applies to', () => {
    const result = analyzeFile(profile7(), TO_81)
    const { args } = buildRepairCommand({
      result,
      settings: TO_81,
      outputPath: OUT,
      convertedVideo: { streamIndex: 0, path: '/scratch/converted.hevc', frameRate: 23.976 }
    })

    const rate = args.indexOf('-r')
    expect(rate).toBeGreaterThan(-1)
    expect(args[rate + 1]).toBe('23.976')
    expect(args[rate + 2]).toBe('-i')
    expect(args[rate + 3]).toBe('/scratch/converted.hevc')
  })

  it('maps the video from the converted file and everything else from the film', () => {
    const result = analyzeFile(profile7(), TO_81)
    const { args } = buildRepairCommand({
      result,
      settings: TO_81,
      outputPath: OUT,
      convertedVideo: { streamIndex: 0, path: '/scratch/converted.hevc', frameRate: 23.976 }
    })

    // Input 1 is the converted stream, and it holds exactly one track.
    expect(maps(args)).toEqual(['1:0', '0:1'])
    expect(valueAfter(args, '-c:v')).toBe('copy')
  })

  /*
   * A converted file is Dolby Vision and has to say so. `preferredHevcTag`
   * only keeps a tag the source already carried, and an MKV source carries
   * none — so without naming it here, converting out of MKV would produce a
   * file every client reads as ordinary HEVC, losing the one thing the
   * conversion was for.
   */
  it('tags the converted stream as Dolby Vision even when the source had no tag', () => {
    const result = analyzeFile(profile7(), TO_81)
    expect(result.file.container).toBe('matroska')
    expect(result.plan.videoCodecTag).toBe('dvh1')
  })

  it('leaves the conversion to the re-encode when the picture has to change anyway', () => {
    // 4:2:2 forces a real transcode, which owns the video track.
    const interlaced = mkv([
      video({
        codec: 'hevc',
        profile: 'Main 10',
        bitDepth: 10,
        pixFmt: 'yuv420p10le',
        isHdr: true,
        dolbyVisionProfile: 7,
        isInterlaced: true,
        fieldOrder: 'tt'
      }),
      mainAudio({ index: 1, codec: 'aac' })
    ])
    const result = analyzeFile(interlaced, TO_81)
    expect(result.plan.videoTranscode).toBeDefined()
    expect(result.plan.dolbyVision7To81).toBeUndefined()
  })
})
