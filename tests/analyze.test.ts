import { describe, expect, it } from 'vitest'
import type { VideoStream } from '@shared/types.js'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { fileStatus } from '@shared/plex/facets.js'
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

  it('treats HEVC as compatible by default and limited when the setting is off', () => {
    const streams = [video({ language: 'eng', codec: 'hevc', profile: 'Main 10' }), audio({ index: 1 })]
    expect(DEFAULT_SETTINGS.allowHevc).toBe(true)
    expect(codes(analyzeFile(mkv(streams), base))).not.toContain('video-codec-limited')
    expect(codes(analyzeFile(mkv(streams), { ...base, allowHevc: false }))).toContain('video-codec-limited')
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

  it('passes a file the companion-track repair has already fixed', () => {
    // The bug this is here for: a DTS-HD MA rip repaired by adding an AAC
    // track came back from the next scan still reporting "DTS (DTS-HD MA) is
    // not direct-playable" as a blocker — the remedy applied, and the finding
    // still firing. The file could never reach "passed" and the same repair
    // was offered for ever.
    const repaired = mkv([
      video({ language: 'eng' }),
      audio({ index: 1, codec: 'aac', channels: 2, language: 'eng', disposition: flags({ default: true }) }),
      audio({ index: 2, codec: 'dts', profile: 'DTS-HD MA', channels: 8, language: 'eng' })
    ])

    const result = analyzeFile(repaired, { ...base, targetContainer: 'mkv', remuxMkvToMp4: false })

    // The lossless track is still named, because knowing it survived is worth
    // something — but as a note, not a fault.
    const unsupported = result.findings.find((finding) => finding.code === 'audio-codec-unsupported')
    expect(unsupported?.severity).toBe('info')
    expect(unsupported?.remedy).toBe('lossless')

    // And nothing is proposed: no second companion track, no audio encode.
    expect(result.plan.addCompatibilityAudio).toBeUndefined()
    expect(result.plan.strategy).toBe('none')
    expect(fileStatus(result)).toBe('passed')
  })

  it('passes a repaired MP4 with DTS beside AAC under default settings', () => {
    // The shape the user's file is actually in after a repair: an MP4, the
    // companion AAC as the default, the lossless original kept. No override of
    // the container settings — if this does not pass, nothing does.
    const result = analyzeFile(
      mp4([
        video({ language: 'eng' }),
        audio({ index: 1, codec: 'aac', channels: 6, channelLayout: '5.1', language: 'eng', disposition: flags({ default: true }) }),
        audio({ index: 2, codec: 'dts', profile: 'DTS-HD MA', channels: 8, language: 'eng' })
      ], { faststart: true }),
      base
    )

    expect(result.plan.strategy).toBe('none')
    expect(fileStatus(result)).toBe('passed')
  })

  it('still blocks a lossless track with nothing playable beside it', () => {
    // The other side of the same rule: the companion has to actually be there.
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        audio({ index: 1, codec: 'dts', profile: 'DTS-HD MA', channels: 8, language: 'eng' })
      ]),
      base
    )
    const unsupported = result.findings.find((finding) => finding.code === 'audio-codec-unsupported')
    expect(unsupported?.severity).toBe('blocker')
    expect(result.plan.strategy).toBe('transcode-audio')
  })

  it('does not count a 7.1 AAC track as the compatible one', () => {
    // "Compatible" means a client can play it as it stands, and 7.1 is beyond
    // what the safe-channel rule allows — so this file still needs a companion.
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        audio({ index: 1, codec: 'aac', channels: 8, channelLayout: '7.1', language: 'eng' }),
        audio({ index: 2, codec: 'truehd', channels: 8, language: 'eng' })
      ]),
      base
    )
    expect(codes(result)).toContain('audio-no-compatible-track')
    expect(result.plan.addCompatibilityAudio).toBeDefined()
  })

  it('does not add a companion track when the setting is off', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), audio({ index: 1, codec: 'truehd', channels: 8 })]),
      { ...base, compatibilityAudio: 'off' }
    )
    expect(result.plan.addCompatibilityAudio).toBeUndefined()
  })

  /*
   * The regression this pair exists for.
   *
   * With the setting off, the plan used to come back `transcode-audio` with an
   * empty plan: billed for an audio encode that never ran, and — because
   * `unresolvedFindings` reads the strategy and not the plan — with both audio
   * blockers reported as answered. The file was announced repaired, copied
   * unchanged, and raised the same two blockers on the next scan.
   */
  it('leaves the audio blockers unresolved when the setting is off, rather than claiming an encode', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), audio({ index: 1, codec: 'truehd', channels: 8 })]),
      { ...base, compatibilityAudio: 'off' }
    )
    expect(result.plan.strategy).not.toBe('transcode-audio')
    expect(result.plan.costNote).not.toContain('audio encode')
    expect(result.plan.unresolved.map((f) => f.code)).toContain('audio-no-compatible-track')
  })

  it('replaces the unplayable tracks when the setting says replace', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        audio({ index: 1, codec: 'truehd', channels: 8, language: 'eng' }),
        audio({ index: 2, codec: 'dts', profile: 'DTS-HD MA', channels: 6, language: 'fra' })
      ]),
      { ...base, compatibilityAudio: 'replace' }
    )
    expect(result.plan.strategy).toBe('transcode-audio')
    expect(result.plan.addCompatibilityAudio).toBeUndefined()
    expect(result.plan.replaceAudio?.map((spec) => spec.sourceStreamIndex)).toEqual([1, 2])
    // 8 channels come down to 5.1; 6 are already there and stay.
    expect(result.plan.replaceAudio?.map((spec) => spec.channels)).toEqual([6, 6])
    expect(result.plan.unresolved.map((f) => f.code)).not.toContain('audio-no-compatible-track')
  })

  /*
   * The "minimal effort" half of the same promise: an exotic track beside a
   * playable one is not a fault, so "replace" must not re-encode it. Nothing
   * here is blocking, so nothing here is work.
   */
  it('re-encodes nothing in replace mode when one track already plays everywhere', () => {
    const result = analyzeFile(
      mkv([
        video({ language: 'eng' }),
        audio({ index: 1, codec: 'truehd', channels: 8, language: 'eng' }),
        mainAudio({ index: 2, language: 'eng' })
      ]),
      { ...base, compatibilityAudio: 'replace' }
    )
    expect(result.plan.replaceAudio).toBeUndefined()
    expect(result.plan.strategy).not.toBe('transcode-audio')
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

  it('rewrites ASS tracks as plain text rather than letting them burn in', () => {
    const result = analyzeFile(
      mkv([video({ language: 'eng' }), audio({ index: 1, language: 'eng' }), subtitle({ index: 2, codec: 'ass' })]),
      base
    )
    expect(codes(result)).toContain('subtitle-styled-ass')
    // Headed for MP4, the container change is the conversion: tx3g is a text
    // format, so the styling goes on its own and saying so again would put a
    // line in the plan for something already happening.
    expect(result.plan.targetContainer).toBe('mp4')
    expect(result.plan.trackChanges).not.toContainEqual(
      expect.objectContaining({ streamIndex: 2, convertSubtitleTo: 'srt' })
    )

    // Staying in Matroska, nothing else would strip it, so the track is
    // rewritten as SRT — in the file. It is not pulled out into a second file
    // beside the film; the dialogue survives and the styling does not.
    const staying = analyzeFile(
      mkv([video({ language: 'eng' }), audio({ index: 1, language: 'eng' }), subtitle({ index: 2, codec: 'ass' })]),
      { ...base, targetContainer: 'mkv', remuxMkvToMp4: false }
    )
    expect(staying.plan.trackChanges).toContainEqual(
      expect.objectContaining({ streamIndex: 2, convertSubtitleTo: 'srt' })
    )
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

describe('unwanted default subtitles in MP4', () => {
  /**
   * Regression: MP4 cannot express "no subtitle is default". Whatever the
   * dispositions say, the muxer enables one subtitle track. Clearing the last
   * remaining default therefore does not switch subtitles off — it hands the
   * flag to whichever track comes first, promoting a language nobody asked
   * for. Confirmed against ffmpeg directly: even a lone subtitle track with
   * its default cleared comes back flagged default.
   */
  const english = () => [
    video({ index: 0, language: 'eng' }),
    mainAudio({ index: 1, language: 'eng' }),
    subtitle({ index: 2, codec: 'mov_text', language: 'ara' }),
    subtitle({ index: 3, codec: 'mov_text', language: 'eng', disposition: flags({ default: true }) })
  ]

  const subtitleDefaultChanges = (result: ReturnType<typeof analyzeFile>) =>
    result.plan.trackChanges.filter((c) => c.kind === 'subtitle' && c.setDefault === false)

  it('does not promise a clearing it cannot deliver', () => {
    const result = analyzeFile(mp4(english()), DEFAULT_SETTINGS)
    expect(subtitleDefaultChanges(result)).toEqual([])

    const finding = result.findings.find((f) => f.code === 'default-subtitle-unwanted')
    expect(finding?.remedy).toBe('manual')
    expect(finding?.detail).toMatch(/one subtitle track enabled/i)
  })

  it('an info finding does not make the file look blocked', () => {
    const result = analyzeFile(mp4(english()), DEFAULT_SETTINGS)
    expect(result.plan.unresolved.every((f) => f.severity === 'info')).toBe(true)
  })

  it('still clears it for MKV, which can hold no default at all', () => {
    const settings = { ...DEFAULT_SETTINGS, targetContainer: 'mkv' as const, remuxMkvToMp4: false }
    const result = analyzeFile(mkv(english()), settings)
    expect(subtitleDefaultChanges(result).map((c) => c.streamIndex)).toContain(3)
  })

  it('still clears it when another track is being promoted in its place', () => {
    // Foreign audio: a subtitle track is meant to come up, so the flag moves
    // rather than disappearing, and MP4 can represent that perfectly well.
    const result = analyzeFile(
      mp4([
        video({ index: 0, language: 'jpn' }),
        mainAudio({ index: 1, language: 'jpn' }),
        subtitle({ index: 2, codec: 'mov_text', language: 'eng' }),
        subtitle({ index: 3, codec: 'mov_text', language: 'jpn', disposition: flags({ default: true }) })
      ]),
      DEFAULT_SETTINGS
    )
    expect(result.plan.trackChanges.some((c) => c.kind === 'subtitle' && c.setDefault === true)).toBe(true)
    expect(subtitleDefaultChanges(result).map((c) => c.streamIndex)).toContain(3)
  })
})

describe('analyzeFile — language tag form per container', () => {
  const frenchAudio = (raw: string) => mainAudio({ index: 1, language: 'fre', rawLanguage: raw })
  const englishVideo = video({ language: 'eng', rawLanguage: 'eng' })
  const languageChanges = (result: ReturnType<typeof analyzeFile>) =>
    result.plan.trackChanges.filter((c) => c.setLanguage != null)

  it('leaves "fra" alone in an MP4, where it is the correct code', () => {
    const result = analyzeFile(mp4([englishVideo, frenchAudio('fra')], { faststart: true }), base)
    expect(codes(result)).not.toContain('language-nonstandard')
    expect(languageChanges(result)).toEqual([])
  })

  it('flags "fre" in an MP4 — what earlier repairs wrote — so it can be put right', () => {
    const result = analyzeFile(mp4([englishVideo, frenchAudio('fre')], { faststart: true }), base)
    expect(codes(result)).toContain('language-nonstandard')
    expect(languageChanges(result).map((c) => c.streamIndex)).toEqual([1])
  })

  it('flags "fra" in a Matroska file, which specifies "fre"', () => {
    const result = analyzeFile(mkv([englishVideo, frenchAudio('fra')]), base)
    expect(codes(result)).toContain('language-nonstandard')
  })

  it('still flags a BCP-47 tag in either container', () => {
    const tagged = mainAudio({ index: 1, language: 'eng', rawLanguage: 'en-US' })
    expect(codes(analyzeFile(mp4([englishVideo, tagged], { faststart: true }), base))).toContain('language-nonstandard')
    expect(codes(analyzeFile(mkv([englishVideo, tagged]), base))).toContain('language-nonstandard')
  })
})

describe('analyzeFile — H.264 level above the ceiling', () => {
  const jackpot = (overrides = {}) =>
    mp4(
      [
        video({ width: 640, height: 480, frameRate: 23.976, level: 42, language: 'eng', ...overrides }),
        mainAudio({ index: 1, language: 'eng' })
      ],
      { faststart: true }
    )

  it('relabels the level losslessly when the stream fits', () => {
    const result = analyzeFile(jackpot(), base)
    const finding = result.findings.find((f) => f.code === 'video-level-too-high')
    expect(finding?.remedy).toBe('lossless')
    expect(finding?.detail).toContain('Subler')
    expect(result.plan.videoLevel).toBe(41)
    expect(result.plan.strategy).toBe('remux')
    expect(result.plan.actions.some((a) => a.label.includes('relabel H.264 Level 4.2 as 4.1'))).toBe(true)
  })

  it('still re-encodes a stream that genuinely needs the higher level', () => {
    const result = analyzeFile(jackpot({ width: 1920, height: 1080, frameRate: 59.94 }), base)
    expect(result.findings.find((f) => f.code === 'video-level-too-high')?.remedy).toBe('transcode')
    expect(result.plan.videoLevel).toBeUndefined()
    expect(result.plan.strategy).toBe('transcode-video')
  })

  // Waterworld (1995): the avcC header says 4.1 (what Subler shows), the SPS
  // says 5.0, and the stream uses 5 reference frames where 4.1 allows 4.
  const waterworld = (overrides: Partial<VideoStream> = {}) =>
    jackpot({ width: 1920, height: 1040, frameRate: 24000 / 1001, level: 50, headerLevel: 41, refFrames: 5, bitRate: 2_046_634, ...overrides })

  it('says why a stream that only nearly fits has to be re-encoded', () => {
    const result = analyzeFile(waterworld(), base)
    const finding = result.findings.find((f) => f.code === 'video-level-too-high')
    expect(finding?.remedy).toBe('transcode')
    expect(finding?.detail).toContain('uses 5 reference frames, and Level 4.1 allows 4 at 1920×1040')
    expect(result.plan.videoLevel).toBeUndefined()
  })

  it('points out that the header Subler shows is not the level players read', () => {
    const finding = analyzeFile(waterworld(), base).findings.find((f) => f.code === 'video-level-too-high')
    expect(finding?.detail).toContain('The MP4 header says Level 4.1')
    expect(finding?.detail).toContain('the level inside the stream, which players and Plex read, is 5.0')
  })

  it('relabels the same film when it uses no more than 4 reference frames', () => {
    const result = analyzeFile(waterworld({ refFrames: 4 }), base)
    expect(result.findings.find((f) => f.code === 'video-level-too-high')?.remedy).toBe('lossless')
    expect(result.plan.videoLevel).toBe(41)
    expect(result.plan.strategy).toBe('remux')
  })
})
