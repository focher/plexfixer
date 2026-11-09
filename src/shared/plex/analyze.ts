/**
 * Compatibility analysis and repair planning.
 *
 * `analyzeFile` is pure: probe output in, findings and a plan out. That keeps
 * the rules unit-testable and lets the UI preview exactly what a repair will do
 * before anything touches the disk.
 */

import type {
  AnalysisResult,
  AppSettings,
  AudioStream,
  Finding,
  FileVerdict,
  MediaFile,
  PlanAction,
  PlanStrategy,
  RepairPlan,
  SubtitleStream,
  TrackPlanChange,
  VideoStream,
  CompatibilityAudioSpec,
  VideoTranscodeSpec
} from '../types.js'
import { languageName, normalizeLanguage } from '../languages.js'
import {
  DOLBY_VISION_SAFE_PROFILES,
  H264_SAFE_PROFILES,
  HEVC_SAFE_PROFILES,
  MAX_SAFE_CHANNELS,
  STYLED_SUBTITLE_CODECS,
  audioCodecTier,
  canStreamCopyIntoMp4,
  formatLevel,
  isImageSubtitle,
  isTextSubtitle,
  videoCodecTier
} from './rules.js'
import { audioStreams, resolvePrimaryLanguage, resolveTracks, subtitleStreams, videoStreams } from './tracks.js'

/* ------------------------------------------------------------------ *
 * Per-stream verdicts
 * ------------------------------------------------------------------ */

interface VideoVerdict {
  findings: Finding[]
  /** The video stream must be re-encoded to be broadly compatible. */
  needsTranscode: boolean
  /** Only the MP4 codec tag is wrong — fixable with a stream copy. */
  needsTagFix: boolean
  /** A deinterlacing filter is required in any re-encode. */
  needsDeinterlace: boolean
  /** The source is >8-bit or non-4:2:0 and must be converted. */
  needsPixelFormatChange: boolean
  /** Downscale target, when the source exceeds the configured ceiling. */
  scaleHeight?: number
}

function analyzeVideo(stream: VideoStream, file: MediaFile, settings: AppSettings): VideoVerdict {
  const findings: Finding[] = []
  let needsTranscode = false
  let needsTagFix = false
  let needsDeinterlace = false
  let needsPixelFormatChange = false
  let scaleHeight: number | undefined

  const codec = stream.codec.toLowerCase()
  const tier = videoCodecTier(codec)
  const profile = (stream.profile ?? '').toLowerCase()

  if (tier === 'none') {
    needsTranscode = true
    findings.push({
      code: 'video-codec-unsupported',
      severity: 'blocker',
      remedy: 'transcode',
      title: `Video codec ${stream.codec.toUpperCase()} is not direct-playable`,
      detail:
        `No mainstream Plex client can decode ${stream.codec.toUpperCase()}, so the server re-encodes the video ` +
        'on every play. Re-encoding once to H.264 removes that cost permanently.',
      streamIndexes: [stream.index]
    })
  } else if (tier === 'limited' && !(codec === 'hevc' && settings.allowHevc)) {
    const isHevc = codec === 'hevc' || codec === 'h265'
    needsTranscode = true
    findings.push({
      code: 'video-codec-limited',
      severity: 'warning',
      remedy: 'transcode',
      title: `Video codec ${stream.codec.toUpperCase()} only direct plays on recent devices`,
      detail: isHevc
        ? 'HEVC direct plays on recent TVs, Apple devices and phones, but not in most browsers or on older ' +
          'streaming boxes. Enable "Treat HEVC as compatible" in Settings if your clients all support it.'
        : `${stream.codec.toUpperCase()} has patchy hardware decoder coverage; a meaningful share of clients ` +
          'will transcode it.',
      streamIndexes: [stream.index]
    })
  }

  // 10-bit H.264 ("High 10") has no consumer hardware decoder at all.
  if (codec === 'h264' && profile.includes('10')) {
    needsTranscode = true
    needsPixelFormatChange = true
    findings.push({
      code: 'video-high10-profile',
      severity: 'blocker',
      remedy: 'transcode',
      title: '10-bit H.264 (High 10 profile)',
      detail:
        'No consumer device has a hardware decoder for 10-bit H.264, so every client transcodes it — usually ' +
        'with heavy CPU cost on the server. Re-encoding to 8-bit H.264 or to HEVC Main 10 fixes it.',
      streamIndexes: [stream.index]
    })
  } else if (codec === 'h264' && profile && !H264_SAFE_PROFILES.has(profile)) {
    needsTranscode = true
    findings.push({
      code: 'video-codec-limited',
      severity: 'warning',
      remedy: 'transcode',
      title: `H.264 ${stream.profile} profile`,
      detail: `The ${stream.profile} profile is outside the Baseline/Main/High set that consumer decoders implement.`,
      streamIndexes: [stream.index]
    })
  }

  if ((codec === 'hevc' || codec === 'h265') && profile && !HEVC_SAFE_PROFILES.has(profile)) {
    needsTranscode = true
    findings.push({
      code: 'video-codec-limited',
      severity: 'warning',
      remedy: 'transcode',
      title: `HEVC ${stream.profile} profile`,
      detail: 'Only HEVC Main and Main 10 have broad hardware decoder support.',
      streamIndexes: [stream.index]
    })
  }

  if (codec === 'h264' && stream.level != null && stream.level > settings.maxH264Level) {
    needsTranscode = true
    findings.push({
      code: 'video-level-too-high',
      severity: 'warning',
      remedy: 'transcode',
      title: `H.264 Level ${formatLevel(stream.level)} exceeds Level ${formatLevel(settings.maxH264Level)}`,
      detail:
        'Decoders advertise a maximum level; above it they refuse the stream outright rather than degrading. ' +
        'Older Apple TVs, Rokus and smart TVs commonly cap at Level 4.1.',
      streamIndexes: [stream.index]
    })
  }

  if (stream.chromaSubsampling === '4:2:2' || stream.chromaSubsampling === '4:4:4') {
    needsTranscode = true
    needsPixelFormatChange = true
    findings.push({
      code: 'video-chroma-unsupported',
      severity: 'blocker',
      remedy: 'transcode',
      title: `${stream.chromaSubsampling} chroma subsampling`,
      detail:
        'Consumer decoders only handle 4:2:0. Anything else is a production/intermediate format and is always ' +
        'transcoded for playback.',
      streamIndexes: [stream.index]
    })
  }

  if (stream.isInterlaced) {
    needsTranscode = true
    needsDeinterlace = true
    findings.push({
      code: 'video-interlaced',
      severity: 'warning',
      remedy: 'transcode',
      title: `Interlaced video (${stream.fieldOrder ?? 'interlaced'})`,
      detail:
        'Few clients deinterlace well, so Plex deinterlaces server-side — which means a full transcode. ' +
        'Deinterlacing once during a re-encode avoids that.',
      streamIndexes: [stream.index]
    })
  }

  if (stream.dolbyVisionProfile != null && !DOLBY_VISION_SAFE_PROFILES.has(stream.dolbyVisionProfile)) {
    findings.push({
      code: 'video-dolby-vision-profile',
      severity: 'blocker',
      remedy: 'manual',
      title: `Dolby Vision profile ${stream.dolbyVisionProfile} without an HDR10 fallback`,
      detail:
        stream.dolbyVisionProfile === 5
          ? 'Profile 5 is single-layer Dolby Vision with no HDR10 base layer. Clients that cannot decode Dolby ' +
            'Vision render it with badly skewed colours (the familiar green/purple cast) rather than falling ' +
            'back gracefully. Converting to profile 8.1 or to plain HDR10 is the reliable fix.'
          : 'This Dolby Vision profile carries an enhancement layer that most clients ignore or mis-handle. ' +
            'Profiles 8.1 and 8.4 degrade cleanly; this one does not.',
      streamIndexes: [stream.index]
    })
  }

  if (stream.height > settings.maxHeight) {
    scaleHeight = settings.maxHeight
    findings.push({
      code: 'video-resolution-high',
      severity: 'warning',
      remedy: 'transcode',
      title: `${stream.width}×${stream.height} exceeds the ${settings.maxHeight}p ceiling`,
      detail:
        'Above the configured ceiling, remote clients on limited bandwidth will downscale server-side. That is ' +
        'a full transcode on every play.',
      streamIndexes: [stream.index]
    })
  }

  if (stream.isAnamorphic) {
    findings.push({
      code: 'video-anamorphic',
      severity: 'info',
      remedy: 'transcode',
      title: `Anamorphic video (sample aspect ratio ${stream.sampleAspectRatio})`,
      detail:
        'Non-square pixels are stretched at playback. Some clients ignore the aspect ratio metadata and show ' +
        'the picture with the wrong geometry.',
      streamIndexes: [stream.index]
    })
  }

  if (stream.refFrames != null && stream.refFrames > 4 && stream.height >= 720) {
    findings.push({
      code: 'video-refframes-high',
      severity: 'info',
      remedy: 'transcode',
      title: `${stream.refFrames} reference frames at ${stream.height}p`,
      detail:
        'Hardware decoders have a reference-frame budget that scales down with resolution. More than 4 at HD ' +
        'resolutions trips up some TV and streaming-box decoders.',
      streamIndexes: [stream.index]
    })
  }

  // In MP4, HEVC must carry the `hvc1` codec tag. With `hev1`, Apple clients
  // refuse the file outright — and this is pure metadata, fixed by a remux.
  if ((codec === 'hevc' || codec === 'h265') && file.container === 'mp4' && stream.codecTag && stream.codecTag.toLowerCase() !== 'hvc1') {
    needsTagFix = true
    findings.push({
      code: 'video-hevc-wrong-tag',
      severity: 'blocker',
      remedy: 'lossless',
      title: `HEVC tagged as "${stream.codecTag}" instead of "hvc1"`,
      detail:
        'Apple clients (iOS, iPadOS, tvOS, Safari) only accept HEVC in MP4 when the codec tag is hvc1. With ' +
        'hev1 they refuse to play the file at all. This is a metadata-only fix — no re-encoding needed.',
      streamIndexes: [stream.index]
    })
  }

  return { findings, needsTranscode, needsTagFix, needsDeinterlace, needsPixelFormatChange, scaleHeight }
}

interface AudioVerdict {
  findings: Finding[]
  /** Streams that cannot be stream-copied and should be replaced. */
  incompatible: AudioStream[]
  /** True when no single track is safe for a browser/basic client. */
  needsCompatibilityTrack: boolean
}

function analyzeAudio(streams: AudioStream[], settings: AppSettings): AudioVerdict {
  const findings: Finding[] = []
  const incompatible: AudioStream[] = []

  for (const stream of streams) {
    const tier = audioCodecTier(stream.codec, stream.profile)
    const label = stream.profile ? `${stream.codec.toUpperCase()} (${stream.profile})` : stream.codec.toUpperCase()

    if (tier === 'none') {
      incompatible.push(stream)
      findings.push({
        code: 'audio-codec-unsupported',
        severity: 'blocker',
        remedy: 'transcode',
        title: `Audio track #${stream.index}: ${label} is not direct-playable`,
        detail:
          `${label} is a lossless or legacy format that streaming clients cannot decode. Plex transcodes it on ` +
          'every play. Adding a compatible companion track keeps the original intact while giving every client ' +
          'something it can play directly.',
        streamIndexes: [stream.index]
      })
    } else if (tier === 'limited') {
      findings.push({
        code: 'audio-codec-limited',
        severity: 'warning',
        remedy: 'transcode',
        title: `Audio track #${stream.index}: ${label} has limited client support`,
        detail: `${label} direct plays on some clients but is transcoded on others, notably web browsers.`,
        streamIndexes: [stream.index]
      })
    }

    if (stream.channels > MAX_SAFE_CHANNELS) {
      findings.push({
        code: 'audio-channels-high',
        severity: 'info',
        remedy: 'transcode',
        title: `Audio track #${stream.index}: ${stream.channels} channels`,
        detail:
          `${stream.channelLayout ?? `${stream.channels} channels`} is downmixed by most clients, and any ` +
          'downmix is a transcode. A 5.1 or stereo companion track avoids it.',
        streamIndexes: [stream.index]
      })
    }
  }

  // The decisive question: is there at least one track every client can play?
  const hasUniversal = streams.some((s) => {
    const tier = audioCodecTier(s.codec, s.profile)
    return tier === 'universal' && s.channels <= MAX_SAFE_CHANNELS
  })
  const needsCompatibilityTrack = streams.length > 0 && !hasUniversal && settings.ensureAacStereo

  if (streams.length > 0 && !hasUniversal) {
    findings.push({
      code: 'audio-no-compatible-track',
      severity: 'blocker',
      remedy: 'transcode',
      title: 'No universally compatible audio track',
      detail:
        'Not one audio track is AAC at 5.1 or below, so every client without a matching decoder transcodes ' +
        'audio. Adding an AAC track alongside the originals is cheap and fixes it for all of them.',
      streamIndexes: streams.map((s) => s.index)
    })
  }

  return { findings, incompatible, needsCompatibilityTrack }
}

interface SubtitleVerdict {
  findings: Finding[]
  /** Streams that cannot live in the target container and must be dropped. */
  dropForContainer: SubtitleStream[]
  /** Streams worth pulling out to sidecar .srt files. */
  extract: SubtitleStream[]
}

function analyzeSubtitles(
  streams: SubtitleStream[],
  targetContainer: 'mp4' | 'mkv',
  settings: AppSettings
): SubtitleVerdict {
  const findings: Finding[] = []
  const dropForContainer: SubtitleStream[] = []
  const extract: SubtitleStream[] = []

  const imageBased = streams.filter((s) => isImageSubtitle(s.codec))
  const styled = streams.filter((s) => STYLED_SUBTITLE_CODECS.has(s.codec.toLowerCase()))

  if (imageBased.length > 0) {
    findings.push({
      code: 'subtitle-image-based',
      severity: 'warning',
      remedy: targetContainer === 'mp4' ? 'lossless' : 'manual',
      title: `${imageBased.length} image-based subtitle track${imageBased.length === 1 ? '' : 's'} (PGS/VobSub)`,
      detail:
        'Image subtitles cannot be rendered as text by Plex clients. Any time one is selected, Plex burns it ' +
        'into the picture — a full video transcode, even for a file that would otherwise direct play. They are ' +
        'harmless while unselected, but risky to leave in place.',
      streamIndexes: imageBased.map((s) => s.index)
    })
    if (targetContainer === 'mp4' && settings.dropImageSubtitlesOnMp4) {
      dropForContainer.push(...imageBased)
    }
  }

  if (styled.length > 0) {
    findings.push({
      code: 'subtitle-styled-ass',
      severity: 'info',
      remedy: 'lossless',
      title: `${styled.length} styled subtitle track${styled.length === 1 ? '' : 's'} (ASS/SSA)`,
      detail:
        'ASS/SSA carries positioning, fonts and karaoke effects that clients cannot reproduce, so Plex burns ' +
        'these in rather than converting them. Extracting a plain .srt sidecar gives clients a track they can ' +
        'render without transcoding.',
      streamIndexes: styled.map((s) => s.index)
    })
  }

  if (targetContainer === 'mp4') {
    const unsupported = streams.filter((s) => !canStreamCopyIntoMp4('subtitle', s.codec))
    const notAlreadyDropped = unsupported.filter((s) => !dropForContainer.includes(s))
    if (notAlreadyDropped.length > 0) {
      findings.push({
        code: 'subtitle-unsupported-in-mp4',
        severity: 'warning',
        remedy: 'lossless',
        title: `${notAlreadyDropped.length} subtitle track${notAlreadyDropped.length === 1 ? '' : 's'} cannot be stored in MP4`,
        detail:
          'MP4 only holds tx3g (mov_text) subtitles. These tracks will be dropped from the MP4; extract them ' +
          'as sidecar files first if you want to keep them.',
        streamIndexes: notAlreadyDropped.map((s) => s.index)
      })
      dropForContainer.push(...notAlreadyDropped)
    }
  }

  if (settings.extractTextSubtitles) {
    // Worth extracting: anything text-based that either will be dropped, or is
    // styled (and so would be burned in rather than rendered).
    for (const stream of streams) {
      if (!isTextSubtitle(stream.codec)) continue
      const isStyled = STYLED_SUBTITLE_CODECS.has(stream.codec.toLowerCase())
      const willBeDropped = dropForContainer.includes(stream)
      if (isStyled || willBeDropped) extract.push(stream)
    }
  }

  return { findings, dropForContainer, extract }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function analyzeFile(file: MediaFile, settings: AppSettings): AnalysisResult {
  const findings: Finding[] = []
  const video = videoStreams(file)
  const audio = audioStreams(file)
  const subtitles = subtitleStreams(file)

  const primary = resolvePrimaryLanguage(file, settings)

  /* --- streams -------------------------------------------------------- */

  if (video.length === 0) {
    findings.push({
      code: 'video-missing',
      severity: 'blocker',
      remedy: 'manual',
      title: 'No video track',
      detail: 'The file contains no video stream and will not play as a movie or episode.'
    })
  } else if (video.length > 1) {
    findings.push({
      code: 'video-multiple',
      severity: 'warning',
      remedy: 'lossless',
      title: `${video.length} video tracks`,
      detail:
        'Extra video tracks confuse client decoders and Plex metadata matching. Keeping only the primary ' +
        'track avoids it.',
      streamIndexes: video.map((s) => s.index)
    })
  }

  const videoVerdict: VideoVerdict = video[0]
    ? analyzeVideo(video[0], file, settings)
    : { findings: [], needsTranscode: false, needsTagFix: false, needsDeinterlace: false, needsPixelFormatChange: false }
  findings.push(...videoVerdict.findings)

  const audioVerdict = analyzeAudio(audio, settings)
  findings.push(...audioVerdict.findings)

  /* --- container -------------------------------------------------------
   *
   * The container decision comes after the stream analysis, because what the
   * streams are determines whether MP4 is even reachable. Deciding first and
   * patching up afterwards is how a planner ends up copying FLAC into an MP4.
   */

  let targetContainer: 'mp4' | 'mkv' = settings.targetContainer
  let containerChange = false

  if (file.container === 'matroska' && !(settings.remuxMkvToMp4 && settings.targetContainer === 'mp4')) {
    targetContainer = 'mkv'
  }

  // A video codec MP4 cannot hold only forces MKV if we are not re-encoding
  // the video anyway — a re-encode produces H.264/HEVC, which MP4 accepts.
  const videoBlocksMp4 = video[0] != null && !canStreamCopyIntoMp4('video', video[0].codec) && !videoVerdict.needsTranscode

  // Audio is different: dropping a lossless track to satisfy the container
  // would destroy data the user may well care about, so the container yields
  // instead and the file stays MKV.
  const audioBlockingMp4 = audio.filter((s) => !canStreamCopyIntoMp4('audio', s.codec))

  if (targetContainer === 'mp4' && file.container !== 'mp4' && (videoBlocksMp4 || audioBlockingMp4.length > 0)) {
    targetContainer = 'mkv'
    const reason =
      audioBlockingMp4.length > 0
        ? `${[...new Set(audioBlockingMp4.map((s) => s.codec.toUpperCase()))].join(' and ')} audio`
        : `${video[0]?.codec.toUpperCase()} video`
    findings.push({
      code: 'container-blocked-by-stream',
      severity: 'info',
      remedy: 'manual',
      title: `Cannot rewrap to MP4: ${reason} is not storable in MP4`,
      detail:
        `MP4 cannot hold ${reason}. The file stays MKV so the track is not lost — dropping it would be ` +
        'destructive. Clients that cannot read MKV will Direct Stream it, which is cheap compared with a ' +
        'full transcode.'
    })
  }

  if (file.container === 'other') {
    findings.push({
      code: 'container-unsupported',
      severity: 'blocker',
      remedy: 'lossless',
      title: `Container "${file.formatName}" is outside Plex's reliable set`,
      detail: 'Plex handles MP4 and MKV reliably across clients; other containers are hit and miss.'
    })
    containerChange = true
  } else if (file.container === 'matroska' && targetContainer === 'mp4') {
    findings.push({
      code: 'container-not-mp4',
      severity: 'warning',
      remedy: 'lossless',
      title: 'MKV container',
      detail:
        'Plex clients that cannot read MKV (browsers, Chromecast, several smart TVs, older Apple TVs) force a ' +
        'Direct Stream remux on every play — extra server work and a common cause of playback stalls on remote ' +
        'connections. MP4 direct plays everywhere.'
    })
    containerChange = true
  }

  if (file.container === 'mp4' && file.faststart === false) {
    findings.push({
      code: 'mp4-not-faststart',
      severity: 'blocker',
      remedy: 'lossless',
      title: 'MP4 index (moov atom) is at the end of the file',
      detail:
        'A client has to read the index before it can start playing. With the moov atom at the end, remote ' +
        'clients stall while the whole file is fetched, or fall back to transcoding. Moving it to the front is ' +
        'a metadata-only rewrite.'
    })
    targetContainer = 'mp4'
  }

  const subtitleVerdict = analyzeSubtitles(subtitles, targetContainer, settings)
  findings.push(...subtitleVerdict.findings)

  /* --- track defaults and languages ------------------------------------ */

  const trackResolution = resolveTracks(file, settings, primary)
  findings.push(...trackResolution.findings)

  /* --- plan ------------------------------------------------------------ */

  const actions: PlanAction[] = []
  const trackChanges: TrackPlanChange[] = [...trackResolution.changes]

  for (const stream of subtitleVerdict.dropForContainer) {
    trackChanges.push({
      streamIndex: stream.index,
      kind: 'subtitle',
      drop: true,
      reason: `${stream.codec.toUpperCase()} cannot be stored in MP4`
    })
  }
  for (const stream of video.slice(1)) {
    trackChanges.push({
      streamIndex: stream.index,
      kind: 'video',
      drop: true,
      reason: 'Secondary video track'
    })
  }

  let strategy: PlanStrategy = 'none'

  if (videoVerdict.needsTranscode) {
    strategy = 'transcode-video'
    const target = settings.transcodeVideoCodec === 'hevc' ? 'HEVC Main 10' : 'H.264 High @ 8-bit'
    actions.push({
      label: `Re-encode video to ${target}`,
      detail:
        `The current video stream cannot be direct played. Re-encoding to ${target} makes it play natively on ` +
        'every client, at the cost of one encode now.'
    })
  } else if (audioVerdict.needsCompatibilityTrack || audioVerdict.incompatible.length > 0) {
    strategy = 'transcode-audio'
  } else if (containerChange || videoVerdict.needsTagFix || file.faststart === false || trackChanges.length > 0) {
    strategy = 'remux'
  }

  if (containerChange || file.faststart === false || videoVerdict.needsTagFix) {
    const parts: string[] = []
    if (containerChange) parts.push(`rewrap as ${targetContainer.toUpperCase()}`)
    if (file.faststart === false) parts.push('move the index to the front of the file')
    if (videoVerdict.needsTagFix) parts.push('retag HEVC as hvc1')
    actions.push({
      label: `Remux: ${parts.join(', ')}`,
      detail: 'Stream copy — the audio and video data are not touched.'
    })
    if (strategy === 'none') strategy = 'remux'
  }

  let addCompatibilityAudio: CompatibilityAudioSpec | undefined
  if (audioVerdict.needsCompatibilityTrack && audio.length > 0) {
    // Derive the companion track from the audio the viewer would actually pick:
    // the one chosen as default, so the new track carries the right language.
    const chosen =
      audio.find((s) => s.index === trackResolution.defaultAudioIndex) ??
      audio.find((s) => audioCodecTier(s.codec, s.profile) !== 'universal') ??
      audio[0]
    const channels = Math.max(2, Math.min(chosen.channels || 2, MAX_SAFE_CHANNELS))
    const language = normalizeLanguage(
      trackChanges.find((c) => c.streamIndex === chosen.index && c.setLanguage)?.setLanguage ?? chosen.language
    )
    addCompatibilityAudio = {
      sourceStreamIndex: chosen.index,
      channels,
      language,
      bitrateKbps: channels * settings.aacBitratePerChannel
    }
    actions.push({
      label: `Add an AAC ${channels > 2 ? `${channels}ch` : 'stereo'} audio track (${languageName(language)})`,
      detail:
        'The original audio tracks are kept untouched. The new AAC track becomes the default so every client ' +
        'has something it can play without transcoding.'
    })

    // The companion track takes over as the default, so every original audio
    // track must give the flag up — otherwise the output ships with two default
    // audio tracks, which is exactly the ambiguity this app exists to remove.
    for (let index = trackChanges.length - 1; index >= 0; index--) {
      const change = trackChanges[index]
      if (change.kind === 'audio' && change.setDefault != null) trackChanges.splice(index, 1)
    }
    for (const stream of audio) {
      if (!stream.disposition.default) continue
      trackChanges.push({
        streamIndex: stream.index,
        kind: 'audio',
        setDefault: false,
        reason: 'Superseded as default by the new AAC track'
      })
    }
  }

  if (subtitleVerdict.extract.length > 0) {
    actions.push({
      label: `Extract ${subtitleVerdict.extract.length} subtitle track${subtitleVerdict.extract.length === 1 ? '' : 's'} to .srt sidecars`,
      detail:
        'Sidecar SRT files are rendered as text by every Plex client, so they never trigger a burn-in transcode.'
    })
  }

  if (trackResolution.changes.length > 0) {
    const languageFixes = trackResolution.changes.filter((c) => c.setLanguage).length
    const flagFixes = trackResolution.changes.filter((c) => c.setDefault != null || c.setForced != null).length
    const parts: string[] = []
    if (languageFixes > 0) parts.push(`${languageFixes} language tag${languageFixes === 1 ? '' : 's'}`)
    if (flagFixes > 0) parts.push(`${flagFixes} default/forced flag${flagFixes === 1 ? '' : 's'}`)
    actions.push({
      label: `Fix ${parts.join(' and ')}`,
      detail:
        trackResolution.defaultAudioLanguage != null
          ? `Default audio becomes the ${languageName(trackResolution.defaultAudioLanguage)} track, matching the ` +
            `video's language (${languageName(primary.language)}).`
          : 'Track metadata is corrected so clients select predictably.'
    })
  }

  const unresolved = findings.filter((f) => {
    if (f.remedy === 'manual') return true
    if (f.remedy === 'transcode' && strategy !== 'transcode-video') {
      // Audio-only transcode findings are resolved by the companion track.
      const audioCodes = ['audio-codec-unsupported', 'audio-codec-limited', 'audio-channels-high', 'audio-no-compatible-track']
      if (audioCodes.includes(f.code) && strategy === 'transcode-audio') return false
      return true
    }
    return false
  })

  const costNote =
    strategy === 'transcode-video'
      ? 'Full video re-encode — minutes to hours per file, GPU accelerated where available'
      : strategy === 'transcode-audio'
        ? 'Stream copy plus one audio encode — roughly as fast as a file copy'
        : strategy === 'remux'
          ? 'Stream copy — limited by disk speed'
          : 'Nothing to do'

  const videoTranscode: VideoTranscodeSpec | undefined =
    videoVerdict.needsTranscode && video[0]
      ? {
          sourceStreamIndex: video[0].index,
          codec: settings.transcodeVideoCodec,
          deinterlace: videoVerdict.needsDeinterlace,
          scaleHeight: videoVerdict.scaleHeight,
          // HEVC Main 10 can carry 10-bit; H.264 cannot, so anything above
          // 8-bit has to be converted when targeting H.264.
          forceYuv420p:
            videoVerdict.needsPixelFormatChange ||
            settings.transcodeVideoCodec === 'h264' ||
            (video[0].bitDepth ?? 8) > 10,
          quality: settings.videoQuality
        }
      : undefined

  // An existing hvc1 tag is preserved; an hev1 tag is corrected. When we
  // re-encode to HEVC and target MP4, the tag must be set explicitly.
  const outputVideoCodec = videoTranscode?.codec ?? video[0]?.codec.toLowerCase()
  const videoCodecTag =
    targetContainer === 'mp4' && (outputVideoCodec === 'hevc' || outputVideoCodec === 'h265') ? 'hvc1' : undefined

  const plan: RepairPlan = {
    strategy,
    targetContainer,
    actions,
    trackChanges,
    extractSubtitles: subtitleVerdict.extract.map((s) => ({
      streamIndex: s.index,
      language: normalizeLanguage(s.language),
      forced: s.disposition.forced
    })),
    addCompatibilityAudio,
    videoTranscode,
    faststart: targetContainer === 'mp4',
    videoCodecTag,
    unresolved,
    requiresTranscode: strategy === 'transcode-video',
    costNote
  }

  const verdict = verdictFor(findings)

  return {
    file,
    verdict,
    findings,
    plan,
    primaryLanguage: primary.language,
    primaryLanguageSource: primary.source
  }
}

function verdictFor(findings: Finding[]): FileVerdict {
  if (findings.some((f) => f.severity === 'blocker')) return 'fail'
  if (findings.some((f) => f.severity === 'warning')) return 'warn'
  return 'ok'
}
