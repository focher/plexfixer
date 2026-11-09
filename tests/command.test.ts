import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import type { EncoderCapabilities } from '@shared/types.js'
import { buildRepairCommand, buildSubtitleExtractCommands, chooseVideoEncoder } from '../src/main/jobs/command.js'
import { audio, flags, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

const OUT = '/out/Example (2020).mp4'

/** The value of the option immediately following `flag`. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** Every `-map` target in order. */
function maps(args: string[]): string[] {
  return args.flatMap((arg, index) => (arg === '-map' ? [args[index + 1]] : []))
}

describe('buildRepairCommand — remux', () => {
  it('stream copies and writes a faststart MP4', () => {
    const result = analyzeFile(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]), DEFAULT_SETTINGS)
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })

    expect(valueAfter(args, '-i')).toBe(result.file.path)
    expect(valueAfter(args, '-c:v')).toBe('copy')
    expect(valueAfter(args, '-c:a')).toBe('copy')
    expect(valueAfter(args, '-movflags')).toBe('+faststart')
    expect(args.at(-1)).toBe(OUT)
  })

  it('omits PGS tracks the plan dropped', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' }),
        subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', isImageBased: true, language: 'eng' })
      ]),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })
    expect(maps(args)).toEqual(['0:0', '0:1'])
  })

  it('converts text subtitles to mov_text for MP4 and leaves them alone for MKV', () => {
    const streams = [video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' }), subtitle({ index: 2 })]
    const mp4Plan = analyzeFile(mkv(streams), DEFAULT_SETTINGS)
    expect(valueAfter(buildRepairCommand({ result: mp4Plan, settings: DEFAULT_SETTINGS, outputPath: OUT }).args, '-c:s')).toBe(
      'mov_text'
    )

    const mkvSettings = { ...DEFAULT_SETTINGS, targetContainer: 'mkv' as const, remuxMkvToMp4: false }
    const mkvPlan = analyzeFile(mkv(streams), mkvSettings)
    expect(valueAfter(buildRepairCommand({ result: mkvPlan, settings: mkvSettings, outputPath: '/out/x.mkv' }).args, '-c:s')).toBe(
      'copy'
    )
  })

  it('retags hev1 as hvc1 without re-encoding', () => {
    const settings = { ...DEFAULT_SETTINGS, allowHevc: true }
    const result = analyzeFile(
      mp4([video({ language: 'eng', codec: 'hevc', profile: 'Main 10', codecTag: 'hev1' }), mainAudio({ index: 1 })]),
      settings
    )
    const { args } = buildRepairCommand({ result, settings, outputPath: OUT })
    expect(valueAfter(args, '-tag:v')).toBe('hvc1')
    expect(valueAfter(args, '-c:v')).toBe('copy')
  })
})

describe('buildRepairCommand — track flags', () => {
  it('addresses dispositions by output ordinal, not input index', () => {
    // Input indexes 1 and 2 are audio; after a drop they become a:0 and a:1.
    const result = analyzeFile(
      mkv([
        video({ language: 'jpn' }),
        mainAudio({ index: 1, language: 'eng' }),
        audio({ index: 2, language: 'jpn' })
      ]),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })

    // Track 2 (jpn) becomes the default; track 1 (eng) loses the flag.
    expect(valueAfter(args, '-disposition:a:1')).toBe('default')
    expect(valueAfter(args, '-disposition:a:0')).toBe('0')
  })

  it('writes corrected language tags against the output ordinal', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' }), audio({ index: 2, language: 'und' })]),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })
    expect(valueAfter(args, '-metadata:s:a:1')).toBe('language=eng')
  })

  it('preserves unrelated dispositions when flipping the default flag', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' }),
        audio({ index: 2, language: 'eng', disposition: flags({ default: true, commentary: true }) })
      ]),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })
    // The commentary flag survives even though `default` is being cleared.
    expect(valueAfter(args, '-disposition:a:1')).toBe('comment')
  })
})

describe('buildRepairCommand — companion audio', () => {
  it('maps the source track twice and encodes the copy to AAC', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), mainAudio({ index: 1, codec: 'truehd', channels: 8, language: 'eng' })]),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })

    expect(maps(args)).toEqual(['0:0', '0:1', '0:1'])
    // The companion track is first among the audio streams.
    expect(valueAfter(args, '-c:a:0')).toBe('aac')
    expect(valueAfter(args, '-ac:a:0')).toBe('6')
    expect(valueAfter(args, '-b:a:0')).toBe(`${6 * DEFAULT_SETTINGS.aacBitratePerChannel}k`)
    expect(valueAfter(args, '-disposition:a:0')).toBe('default')
    // The TrueHD original is copied, not re-encoded.
    expect(valueAfter(args, '-c:a')).toBe('copy')
  })

  it('leaves exactly one default audio track in the output', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        mainAudio({ index: 1, codec: 'truehd', channels: 8, language: 'eng' }),
        audio({ index: 2, codec: 'dts', profile: 'DTS-HD MA', channels: 8, language: 'eng' })
      ]),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })

    const dispositions = args.flatMap((arg, index) =>
      arg.startsWith('-disposition:a:') ? [[arg, args[index + 1]] as const] : []
    )
    const defaults = dispositions.filter(([, value]) => value.split('+').includes('default'))
    expect(defaults).toEqual([['-disposition:a:0', 'default']])
    // The original that held the flag is explicitly cleared.
    expect(valueAfter(args, '-disposition:a:1')).toBe('0')
  })
})

describe('buildRepairCommand — video re-encode', () => {
  const nvidia: EncoderCapabilities = {
    platform: 'win32',
    available: ['h264_nvenc', 'hevc_nvenc'],
    nvenc: true,
    videotoolbox: false,
    qsv: false,
    amf: false
  }

  it('uses NVENC with constant-quality VBR when it is available', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', profile: 'High 10', pixFmt: 'yuv420p10le', bitDepth: 10 }), mainAudio({ index: 1 })]),
      DEFAULT_SETTINGS
    )
    const { args, encoderLabel } = buildRepairCommand({
      result,
      settings: DEFAULT_SETTINGS,
      caps: nvidia,
      outputPath: OUT
    })

    expect(valueAfter(args, '-c:v')).toBe('h264_nvenc')
    expect(valueAfter(args, '-cq')).toBe(String(DEFAULT_SETTINGS.videoQuality))
    expect(valueAfter(args, '-b:v')).toBe('0')
    expect(encoderLabel).toContain('NVENC')
    // 10-bit source targeting H.264 must be converted down to 8-bit 4:2:0.
    expect(valueAfter(args, '-vf')).toContain('format=yuv420p')
    expect(valueAfter(args, '-level:v')).toBe('4.1')
  })

  it('falls back to libx264 when no hardware encoder is usable', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', profile: 'High 10', bitDepth: 10 }), mainAudio({ index: 1 })]),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })
    expect(valueAfter(args, '-c:v')).toBe('libx264')
    expect(valueAfter(args, '-crf')).toBe(String(DEFAULT_SETTINGS.videoQuality))
  })

  it('deinterlaces and downscales in one filter chain', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', isInterlaced: true, fieldOrder: 'tt', height: 2160, width: 3840 }), mainAudio({ index: 1 })]),
      { ...DEFAULT_SETTINGS, maxHeight: 1080 }
    )
    const { args } = buildRepairCommand({ result, settings: { ...DEFAULT_SETTINGS, maxHeight: 1080 }, outputPath: OUT })
    const filters = valueAfter(args, '-vf') ?? ''
    expect(filters).toContain('yadif')
    expect(filters).toContain('scale=-2:1080')
  })

  it('omits the level cap above 1080p, where Level 4.1 cannot apply', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', profile: 'High 10', bitDepth: 10, height: 2160, width: 3840 }), mainAudio({ index: 1 })]),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })
    expect(args).not.toContain('-level:v')
  })
})

describe('chooseVideoEncoder', () => {
  it('respects an explicit CPU-only preference', () => {
    const caps: EncoderCapabilities = {
      platform: 'win32',
      available: ['h264_nvenc'],
      nvenc: true,
      videotoolbox: false,
      qsv: false,
      amf: false
    }
    const choice = chooseVideoEncoder('h264', 21, { ...DEFAULT_SETTINGS, hardwareEncoder: 'none' }, caps)
    expect(choice.encoder).toBe('libx264')
    expect(choice.hardware).toBe(false)
  })

  it('does not offer an encoder the capability probe rejected', () => {
    const caps: EncoderCapabilities = {
      platform: 'win32',
      available: ['h264_nvenc'],
      // Listed by the build, but the test encode failed — no NVIDIA driver.
      nvenc: false,
      videotoolbox: false,
      qsv: false,
      amf: false
    }
    expect(chooseVideoEncoder('h264', 21, { ...DEFAULT_SETTINGS, hardwareEncoder: 'nvenc' }, caps).encoder).toBe('libx264')
  })

  it('inverts the quality scale for VideoToolbox', () => {
    const caps: EncoderCapabilities = {
      platform: 'darwin',
      available: ['h264_videotoolbox'],
      nvenc: false,
      videotoolbox: true,
      qsv: false,
      amf: false
    }
    const choice = chooseVideoEncoder('h264', 21, DEFAULT_SETTINGS, caps)
    expect(choice.encoder).toBe('h264_videotoolbox')
    // CRF 21 is good quality, which on VideoToolbox's 1-100 scale is high.
    expect(Number(choice.rateControl[choice.rateControl.indexOf('-q:v') + 1])).toBeGreaterThan(50)
  })
})

describe('buildSubtitleExtractCommands', () => {
  it('names sidecars so Plex picks them up', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' }),
        subtitle({ index: 2, codec: 'ass', language: 'eng' }),
        subtitle({ index: 3, codec: 'ass', language: 'eng', disposition: flags({ forced: true }) })
      ]),
      DEFAULT_SETTINGS
    )
    const commands = buildSubtitleExtractCommands(result, '/out/Example (2020)')

    expect(commands.map((c) => c.outputPath)).toEqual([
      '/out/Example (2020).eng.srt',
      '/out/Example (2020).eng.forced.srt'
    ])
    expect(valueAfter(commands[0].args, '-c:s')).toBe('srt')
  })

  it('disambiguates two sidecars that would share a name', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' }),
        subtitle({ index: 2, codec: 'ass', language: 'eng' }),
        subtitle({ index: 3, codec: 'ass', language: 'eng', title: 'Alternate' })
      ]),
      DEFAULT_SETTINGS
    )
    const paths = buildSubtitleExtractCommands(result, '/out/Example').map((c) => c.outputPath)
    expect(new Set(paths).size).toBe(paths.length)
  })
})
