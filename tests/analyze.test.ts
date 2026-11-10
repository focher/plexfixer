import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import type { AppSettings } from '@shared/types.js'
import { audio, flags, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

const base: AppSettings = DEFAULT_SETTINGS
const codes = (result: ReturnType<typeof analyzeFile>): string[] => result.findings.map((f) => f.code)

describe('analyzeFile — clean files', () => {
  it('passes an MP4 that is already Plex-ready', () => {
    const result = analyzeFile(
      mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]),
      base
    )
    expect(result.verdict).toBe('ok')
    expect(result.plan.strategy).toBe('none')
    expect(result.findings).toHaveLength(0)
  })
})

describe('analyzeFile — container', () => {
  it('flags MKV and plans a lossless rewrap to MP4', () => {
    const result = analyzeFile(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]), base)
    expect(codes(result)).toContain('container-not-mp4')
    expect(result.plan.strategy).toBe('remux')
    expect(result.plan.targetContainer).toBe('mp4')
    expect(result.plan.requiresTranscode).toBe(false)
  })

  it('leaves MKV alone when the user keeps that container', () => {
    const settings = { ...base, targetContainer: 'mkv' as const, remuxMkvToMp4: false }
    const result = analyzeFile(mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]), settings)
    expect(codes(result)).not.toContain('container-not-mp4')
    expect(result.plan.targetContainer).toBe('mkv')
  })

  it('treats a trailing moov atom as a blocker', () => {
    const result = analyzeFile(
      mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: false }),
      base
    )
    expect(codes(result)).toContain('mp4-not-faststart')
    expect(result.verdict).toBe('fail')
    expect(result.plan.strategy).toBe('remux')
    expect(result.plan.faststart).toBe(true)
  })

  it('keeps MKV rather than dropping audio MP4 cannot store', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), mainAudio({ index: 1, codec: 'flac', channels: 2, language: 'eng' })]),
      base
    )
    expect(result.plan.targetContainer).toBe('mkv')
    expect(codes(result)).toContain('container-blocked-by-stream')
    // The companion AAC track is still added, so clients have something to play.
    expect(result.plan.addCompatibilityAudio).toBeDefined()
  })

  it('still rewraps to MP4 when every stream can live there', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        mainAudio({ index: 1, codec: 'ac3', channels: 6, language: 'eng' })
      ]),
      base
    )
    expect(result.plan.targetContainer).toBe('mp4')
    expect(codes(result)).toContain('container-not-mp4')
  })

  it('keeps MKV when the video codec cannot be stream-copied into MP4', () => {
    const settings = { ...base, allowHevc: true }
    const result = analyzeFile(
      mkv([video({ language: 'eng', codec: 'vp8' }), audio({ index: 1, language: 'eng' })]),
      settings
    )
    // vp8 is both undecodable by clients and unstorable in MP4; the container
    // decision must not quietly force a re-encode on its own.
    expect(result.plan.targetContainer).toBe('mp4')
    expect(result.plan.requiresTranscode).toBe(true)
  })
})

describe('analyzeFile — video', () => {
  it('flags 10-bit H.264 as a blocker needing a re-encode', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', profile: 'High 10', pixFmt: 'yuv420p10le', bitDepth: 10 }), audio({ index: 1 })]),
      base
    )
    expect(codes(result)).toContain('video-high10-profile')
    expect(result.verdict).toBe('fail')
    expect(result.plan.strategy).toBe('transcode-video')
    expect(result.plan.videoTranscode?.forceYuv420p).toBe(true)
  })

  it('flags an H.264 level above the configured ceiling', () => {
    const result = analyzeFile(mkv([video({ language: 'eng', level: 51 }), audio({ index: 1 })]), base)
    expect(codes(result)).toContain('video-level-too-high')
  })

  it('accepts a high level when the ceiling is raised', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', level: 51 }), audio({ index: 1 })]),
      { ...base, maxH264Level: 62 }
    )
    expect(codes(result)).not.toContain('video-level-too-high')
  })

  it('treats HEVC as limited by default and compatible when allowed', () => {
    const streams = [video({ language: 'eng', codec: 'hevc', profile: 'Main 10' }), audio({ index: 1 })]
    expect(codes(analyzeFile(mkv(streams), base))).toContain('video-codec-limited')
    expect(codes(analyzeFile(mkv(streams), { ...base, allowHevc: true }))).not.toContain('video-codec-limited')
  })

  it('flags HEVC in MP4 carrying the hev1 tag as a metadata-only blocker', () => {
    const result = analyzeFile(
      mp4([video({ language: 'eng', codec: 'hevc', profile: 'Main 10', codecTag: 'hev1' }), audio({ index: 1 })]),
      { ...base, allowHevc: true }
    )
    expect(codes(result)).toContain('video-hevc-wrong-tag')
    expect(result.plan.strategy).toBe('remux')
    expect(result.plan.videoCodecTag).toBe('hvc1')
    expect(result.plan.requiresTranscode).toBe(false)
  })

  it('plans a deinterlace for interlaced sources', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', isInterlaced: true, fieldOrder: 'tt' }), audio({ index: 1 })]),
      base
    )
    expect(codes(result)).toContain('video-interlaced')
    expect(result.plan.videoTranscode?.deinterlace).toBe(true)
  })

  it('flags Dolby Vision profile 5 as unfixable without a re-grade', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', codec: 'hevc', profile: 'Main 10', dolbyVisionProfile: 5 }), audio({ index: 1 })]),
      { ...base, allowHevc: true }
    )
    expect(codes(result)).toContain('video-dolby-vision-profile')
    expect(result.plan.unresolved.map((f) => f.code)).toContain('video-dolby-vision-profile')
  })

  it('accepts Dolby Vision profile 8, which falls back to HDR10 cleanly', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng', codec: 'hevc', profile: 'Main 10', dolbyVisionProfile: 8 }), audio({ index: 1 })]),
      { ...base, allowHevc: true }
    )
    expect(codes(result)).not.toContain('video-dolby-vision-profile')
  })
})

describe('analyzeFile — audio', () => {
  it('adds a companion AAC track when only TrueHD is present', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        audio({ index: 1, codec: 'truehd', channels: 8, channelLayout: '7.1', language: 'eng' })
      ]),
      base
    )
    expect(codes(result)).toContain('audio-codec-unsupported')
    expect(codes(result)).toContain('audio-no-compatible-track')
    expect(result.plan.strategy).toBe('transcode-audio')
    expect(result.plan.addCompatibilityAudio).toMatchObject({ sourceStreamIndex: 1, channels: 6, language: 'eng' })
    // The video is untouched, so this still counts as a safe repair.
    expect(result.plan.requiresTranscode).toBe(false)
  })

  it('treats DTS-HD MA as lossless and therefore undecodable by clients', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), audio({ index: 1, codec: 'dts', profile: 'DTS-HD MA', channels: 8 })]),
      base
    )
    expect(codes(result)).toContain('audio-codec-unsupported')
  })

  it('leaves plain DTS as a warning rather than a blocker', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        audio({ index: 1, codec: 'aac', language: 'eng' }),
        audio({ index: 2, codec: 'dts', profile: 'DTS', channels: 6, language: 'eng' })
      ]),
      base
    )
    expect(codes(result)).toContain('audio-codec-limited')
    expect(codes(result)).not.toContain('audio-no-compatible-track')
  })

  it('does not add a companion track when the setting is off', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), audio({ index: 1, codec: 'truehd', channels: 8 })]),
      { ...base, ensureAacStereo: false }
    )
    expect(result.plan.addCompatibilityAudio).toBeUndefined()
  })
})

describe('analyzeFile — subtitles', () => {
  it('drops PGS tracks when rewrapping to MP4', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        audio({ index: 1, language: 'eng' }),
        subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', isImageBased: true })
      ]),
      base
    )
    expect(codes(result)).toContain('subtitle-image-based')
    expect(result.plan.trackChanges).toContainEqual(
      expect.objectContaining({ streamIndex: 2, drop: true })
    )
  })

  it('extracts ASS tracks to sidecars rather than letting them burn in', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), audio({ index: 1, language: 'eng' }), subtitle({ index: 2, codec: 'ass' })]),
      base
    )
    expect(codes(result)).toContain('subtitle-styled-ass')
    expect(result.plan.extractSubtitles).toContainEqual({ streamIndex: 2, language: 'eng', forced: false })
  })
})

describe('analyzeFile — the anime case', () => {
  /**
   * The combination that trips up most libraries: MKV, 10-bit H.264, Japanese
   * audio, English PGS subtitles flagged as default. Every one of those forces
   * work on the server.
   */
  it('catches every problem in a typical 10-bit anime release', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'jpn', profile: 'High 10', pixFmt: 'yuv420p10le', bitDepth: 10, height: 1080 }),
        audio({ index: 1, codec: 'flac', channels: 2, language: 'jpn', disposition: flags({ default: true }) }),
        audio({ index: 2, codec: 'aac', channels: 2, language: 'eng' }),
        subtitle({
          index: 3,
          codec: 'hdmv_pgs_subtitle',
          isImageBased: true,
          language: 'eng',
          disposition: flags({ default: true })
        }),
        subtitle({ index: 4, codec: 'ass', language: 'eng', title: 'Signs & Songs' })
      ]),
      base
    )

    const found = codes(result)
    expect(found).toContain('video-high10-profile')
    expect(found).toContain('subtitle-image-default')
    // FLAC cannot be stored in MP4, so the file stays MKV rather than losing
    // the lossless track; the report says so instead of claiming a rewrap.
    expect(found).toContain('container-blocked-by-stream')
    expect(found).not.toContain('container-not-mp4')
    expect(result.plan.targetContainer).toBe('mkv')
    expect(result.verdict).toBe('fail')
    expect(result.plan.strategy).toBe('transcode-video')
    expect(result.plan.requiresTranscode).toBe(true)

    // Japanese audio stays the default because the video track says Japanese.
    expect(result.primaryLanguage).toBe('jpn')
    expect(result.primaryLanguageSource).toBe('video-stream-tag')
    expect(result.plan.trackChanges).toContainEqual(
      expect.objectContaining({ streamIndex: 3, kind: 'subtitle', setDefault: false })
    )
    // The signs track is marked forced so Plex can auto-select it.
    expect(result.plan.trackChanges).toContainEqual(
      expect.objectContaining({ streamIndex: 4, setForced: true })
    )
  })
})

describe('analyzeFile — HEVC codec tags', () => {
  const hevc = (codecTag: string) =>
    analyzeFile(
      mp4([
        video({ index: 0, codec: 'hevc', codecTag, profile: 'main 10', language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' })
      ]),
      { ...base, allowHevc: true }
    )

  it('corrects hev1 to hvc1', () => {
    const result = hevc('hev1')
    expect(codes(result)).toContain('video-hevc-wrong-tag')
    expect(result.plan.videoCodecTag).toBe('hvc1')
  })

  it('leaves hvc1 alone', () => {
    const result = hevc('hvc1')
    expect(codes(result)).not.toContain('video-hevc-wrong-tag')
  })

  it('leaves a Dolby Vision stream on dvh1 rather than presenting it as plain HEVC', () => {
    const result = hevc('dvh1')
    expect(codes(result)).not.toContain('video-hevc-wrong-tag')
    expect(result.plan.videoCodecTag).toBe('dvh1')
    expect(result.plan.strategy).toBe('none')
  })

  it('corrects dvhe to dvh1, keeping the Dolby Vision tag family', () => {
    const result = hevc('dvhe')
    const finding = result.findings.find((f) => f.code === 'video-hevc-wrong-tag')
    expect(finding?.title).toContain('dvh1')
    expect(result.plan.videoCodecTag).toBe('dvh1')
  })
})

describe('analyzeFile — DRM', () => {
  it('reports a FairPlay file as unrepairable instead of planning a remux', () => {
    const result = analyzeFile(
      mp4([
        video({ index: 0, codec: 'hevc', codecTag: 'drmi', language: 'eng' }),
        mainAudio({ index: 1, language: 'eng' })
      ]),
      base
    )
    const finding = result.findings.find((f) => f.code === 'drm-protected')
    expect(finding?.severity).toBe('blocker')
    expect(finding?.remedy).toBe('manual')
    expect(result.verdict).toBe('fail')
    expect(result.plan.unresolved.map((f) => f.code)).toContain('drm-protected')
  })
})
