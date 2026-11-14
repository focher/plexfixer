import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import type { EncoderCapabilities } from '@shared/types.js'
import { buildRepairCommand, buildSubtitleExtractCommands, chooseVideoEncoder } from '@shared/plex/command.js'
import { audio, coverArt, flags, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

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
    expect(valueAfter(args, '-tag:v:0')).toBe('hvc1')
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

  it('writes ISO 639-2/T when a Matroska "fre" track moves into MP4', () => {
    // ffmpeg copies language tags verbatim; MP4 must get "fra", not "fre".
    const result = analyzeFile(
      mkv([
        video({ language: 'eng', rawLanguage: 'eng' }),
        mainAudio({ index: 1, language: 'fre', rawLanguage: 'fre' })
      ]),
      DEFAULT_SETTINGS
    )
    expect(result.plan.targetContainer).toBe('mp4')
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })
    expect(valueAfter(args, '-metadata:s:a:0')).toBe('language=fra')
    expect(args).not.toContain('language=fre')
  })

  it('leaves a correct MP4 "fra" alone', () => {
    const result = analyzeFile(
      mp4([video({ language: 'eng', rawLanguage: 'eng' }), mainAudio({ index: 1, language: 'fre', rawLanguage: 'fra' })]),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })
    expect(args).not.toContain('language=fre')
    expect(args.filter((arg) => arg.startsWith('language='))).toEqual([])
  })

  it('writes ISO 639-2/B when the output stays Matroska', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', rawLanguage: 'eng' }), mainAudio({ index: 1, language: 'ger', rawLanguage: 'deu' })]),
      { ...DEFAULT_SETTINGS, remuxMkvToMp4: false }
    )
    expect(result.plan.targetContainer).toBe('mkv')
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: '/out/x.mkv' })
    expect(valueAfter(args, '-metadata:s:a:0')).toBe('language=ger')
  })

  it('relabels an H.264 level with a bitstream filter on the real video track, copying the video', () => {
    const result = analyzeFile(
      mp4(
        [
          video({ width: 640, height: 480, level: 42, language: 'eng', rawLanguage: 'eng' }),
          mainAudio({ index: 1, language: 'eng', rawLanguage: 'eng' }),
          coverArt({ index: 2 })
        ],
        { faststart: true }
      ),
      DEFAULT_SETTINGS
    )
    const { args } = buildRepairCommand({ result, settings: DEFAULT_SETTINGS, outputPath: OUT })
    expect(valueAfter(args, '-bsf:v:0')).toBe('h264_metadata=level=4.1')
    expect(valueAfter(args, '-c:v')).toBe('copy')
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
    amf: false,
    libplacebo: false
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
    expect(valueAfter(args, '-filter:v:0')).toContain('format=yuv420p')
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
    const filters = valueAfter(args, '-filter:v:0') ?? ''
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
      amf: false,
      libplacebo: false
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
      amf: false,
      libplacebo: false
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
      amf: false,
      libplacebo: false
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

describe('buildRepairCommand — embedded cover art', () => {
  /**
   * Regression: an M4V carrying poster artwork failed to repair with
   * "Tag hvc1 incompatible with output codec id '7' (mp4v)". ffprobe reports
   * artwork as a video stream, the builder mapped it, and the unscoped
   * `-tag:v hvc1` landed on the JPEG as well as the HEVC track — so the MP4
   * muxer refused to write a header and every other stream failed with it.
   */
  const settings = { ...DEFAULT_SETTINGS, allowHevc: true }

  const withArt = (): ReturnType<typeof analyzeFile> =>
    analyzeFile(
      mp4([
        video({ codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', language: 'eng' }),
        mainAudio({ index: 1, codec: 'aac', language: 'eng' }),
        coverArt({ index: 2 })
      ]),
      settings
    )

  it('keeps the artwork, mapped last and marked as an attached picture', () => {
    const result = withArt()
    const { args } = buildRepairCommand({ result, settings, outputPath: OUT })

    // Last of the video streams, so the real video keeps ordinal 0.
    expect(maps(args)).toContain('0:2')
    expect(valueAfter(args, '-c:v:1')).toBe('copy')
    expect(valueAfter(args, '-disposition:v:1')).toBe('attached_pic')
  })

  it('does not let a video re-encode touch the artwork', () => {
    const result = withArt()
    const transcoding = {
      ...result,
      plan: {
        ...result.plan,
        videoTranscode: {
          sourceStreamIndex: 0,
          codec: 'h264' as const,
          deinterlace: true,
          forceYuv420p: true,
          quality: 20
        }
      }
    }
    const { args } = buildRepairCommand({ result: transcoding, settings, outputPath: OUT })

    // The encoder and the filter graph are both scoped to the real video.
    expect(args).not.toContain('-vf')
    expect(valueAfter(args, '-filter:v:0')).toContain('yadif')
    expect(valueAfter(args, '-c:v:1')).toBe('copy')
  })

  it('scopes the HEVC codec tag to the real video stream', () => {
    const result = withArt()
    const { args } = buildRepairCommand({ result, settings, outputPath: OUT })

    expect(result.plan.videoCodecTag).toBe('hvc1')
    // A bare `-tag:v` would apply to every video output stream.
    expect(args).not.toContain('-tag:v')
    expect(valueAfter(args, '-tag:v:0')).toBe('hvc1')
  })

  it('counts artwork as neither a video track nor a reason to rewrite', () => {
    const result = withArt()
    expect(result.findings.some((f) => f.code === 'video-multiple')).toBe(false)

    // Artwork alone must not manufacture a plan for an otherwise clean file.
    const clean = analyzeFile(
      mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' }), coverArt({ index: 2 })], {
        faststart: true
      }),
      settings
    )
    expect(clean.plan.strategy).toBe('none')
    expect(clean.plan.actions).toEqual([])
  })

  it('does not claim artwork is dropped when an MP4 repair keeps it', () => {
    // The plan used to announce "Drop 1 embedded cover-art track" while the
    // command mapped it straight through, so the report contradicted the
    // command it printed directly beneath itself.
    const result = withArt()
    expect(result.plan.actions.some((a) => /cover-art/i.test(a.label))).toBe(false)
    expect(maps(buildRepairCommand({ result, settings, outputPath: OUT }).args)).toContain('0:2')
  })

  it('still says so for an MKV target, where the artwork really is dropped', () => {
    const mkvSettings = { ...settings, targetContainer: 'mkv' as const, remuxMkvToMp4: false }
    // Two English tracks, neither flagged default, so a repair actually runs.
    const result = analyzeFile(
      mkv([
        video({ codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', language: 'eng' }),
        audio({ index: 1, codec: 'aac', language: 'eng' }),
        audio({ index: 2, codec: 'aac', language: 'eng' }),
        coverArt({ index: 3 })
      ]),
      mkvSettings
    )
    expect(result.plan.strategy).not.toBe('none')
    expect(result.plan.actions.some((a) => /cover-art/i.test(a.label))).toBe(true)
    expect(maps(buildRepairCommand({ result, settings: mkvSettings, outputPath: '/out/E.mkv' }).args)).not.toContain('0:3')
  })
})

describe('buildRepairCommand — muxer selection', () => {
  /**
   * Regression: 0.1.2 started preserving the `.m4v` extension, and ffmpeg
   * infers the muxer from it. `.m4v` selects `ipod` — "iPod H.264 MP4" —
   * which carries no codec tag for HEVC and refuses to write a header:
   *
   *   [ipod] Could not find tag for codec hevc in stream #0
   *
   * Every HEVC .m4v in a library failed to repair. The muxer is named
   * explicitly now, so the extension cannot decide it.
   */
  const settings = { ...DEFAULT_SETTINGS, allowHevc: true }

  const hevcM4v = (): ReturnType<typeof analyzeFile> =>
    analyzeFile(
      mp4([
        video({ codec: 'hevc', codecTag: 'hev1', profile: 'Main 10', language: 'eng' }),
        mainAudio({ index: 1, codec: 'aac', language: 'eng' })
      ]),
      settings
    )

  it('names the mp4 muxer when the output keeps an .m4v extension', () => {
    const { args } = buildRepairCommand({
      result: hevcM4v(),
      settings,
      outputPath: '/out/Episode.m4v'
    })
    expect(valueAfter(args, '-f')).toBe('mp4')
    // It has to reach ffmpeg as an output option, before the file itself.
    expect(args.indexOf('-f')).toBeLessThan(args.length - 1)
    expect(args.at(-1)).toBe('/out/Episode.m4v')
  })

  it('names the matroska muxer for an MKV target', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]),
      { ...DEFAULT_SETTINGS, targetContainer: 'mkv', remuxMkvToMp4: false }
    )
    const { args } = buildRepairCommand({
      result,
      settings: { ...DEFAULT_SETTINGS, targetContainer: 'mkv', remuxMkvToMp4: false },
      outputPath: '/out/Episode.mkv'
    })
    expect(valueAfter(args, '-f')).toBe('matroska')
  })
})
