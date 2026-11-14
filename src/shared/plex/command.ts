/**
 * Turning a `RepairPlan` into ffmpeg arguments.
 *
 * The fiddly part is stream addressing. `-map` takes absolute input indexes
 * (`0:3`), but `-disposition`, `-metadata` and per-stream codec options take
 * *output* ordinals within a type (`:a:1` is the second audio track of the
 * output). The builder therefore tracks both as it assembles the map list.
 */

import type {
  AnalysisResult,
  AppSettings,
  EncoderCapabilities,
  MediaStream,
  RepairPlan,
  TrackPlanChange
} from '../types.js'
import { canStreamCopyIntoMp4, DOLBY_VISION_HDR10_FILTER } from './rules.js'
import { UNDEFINED_LANGUAGE, languageForContainer } from '../languages.js'
import { h264LevelLabel } from './h264-level.js'
import { isCoverArt } from './tracks.js'

/** Per-type output ordinal for a mapped stream. */
interface MappedStream {
  source: MediaStream
  /** 'v' | 'a' | 's' | 't' — the ffmpeg stream-specifier letter. */
  specifier: 'v' | 'a' | 's' | 't'
  ordinal: number
}

function specifierFor(stream: MediaStream): 'v' | 'a' | 's' | 't' | undefined {
  switch (stream.kind) {
    case 'video':
      return 'v'
    case 'audio':
      return 'a'
    case 'subtitle':
      return 's'
    case 'attachment':
      return 't'
    default:
      return undefined
  }
}

function changeFor(plan: RepairPlan, streamIndex: number): TrackPlanChange | undefined {
  // Several changes can target one stream (language + flags); merge them.
  const matches = plan.trackChanges.filter((c) => c.streamIndex === streamIndex)
  if (matches.length === 0) return undefined
  return matches.reduce((acc, next) => ({
    ...acc,
    ...next,
    reason: acc.reason === next.reason ? acc.reason : `${acc.reason}; ${next.reason}`
  }))
}

/* ------------------------------------------------------------------ *
 * Video encoder selection
 * ------------------------------------------------------------------ */

export interface EncoderChoice {
  /** ffmpeg encoder name, e.g. `h264_nvenc`. */
  encoder: string
  /** Rate-control arguments for the chosen quality. */
  rateControl: string[]
  /** Human label for the UI. */
  label: string
  hardware: boolean
}

/**
 * Pick the video encoder.
 *
 * NVENC is preferred when it is actually usable (detection runs a real test
 * encode, so a build that merely advertises it does not win). VideoToolbox
 * covers Apple hardware, which has no NVENC at all. libx264/libx265 is the
 * fallback and is always correct, just slow.
 */
export function chooseVideoEncoder(
  codec: 'h264' | 'hevc',
  quality: number,
  settings: AppSettings,
  caps: EncoderCapabilities | undefined
): EncoderChoice {
  const preference = settings.hardwareEncoder
  const want = (kind: 'nvenc' | 'videotoolbox' | 'qsv' | 'amf'): boolean => {
    if (preference === 'none') return false
    if (preference !== 'auto' && preference !== kind) return false
    return caps?.[kind] === true
  }

  if (want('nvenc')) {
    return {
      encoder: `${codec}_nvenc`,
      // Constant-quality VBR: -cq sets the target, -b:v 0 keeps the bitrate
      // cap out of the way so quality, not bitrate, drives the encode.
      rateControl: ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0'],
      label: `NVIDIA NVENC (${codec.toUpperCase()})`,
      hardware: true
    }
  }

  if (want('qsv')) {
    return {
      encoder: `${codec}_qsv`,
      rateControl: ['-global_quality', String(quality), '-preset', 'medium'],
      label: `Intel Quick Sync (${codec.toUpperCase()})`,
      hardware: true
    }
  }

  if (want('amf')) {
    return {
      encoder: `${codec}_amf`,
      rateControl: ['-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality), '-quality', 'balanced'],
      label: `AMD AMF (${codec.toUpperCase()})`,
      hardware: true
    }
  }

  if (want('videotoolbox')) {
    // VideoToolbox quality runs 1-100, higher is better — the inverse of CRF.
    const q = Math.max(10, Math.min(95, Math.round(100 - quality * 1.8)))
    return {
      encoder: `${codec}_videotoolbox`,
      rateControl: ['-q:v', String(q)],
      label: `Apple VideoToolbox (${codec.toUpperCase()})`,
      hardware: true
    }
  }

  return {
    encoder: codec === 'hevc' ? 'libx265' : 'libx264',
    rateControl: ['-preset', 'medium', '-crf', String(quality)],
    label: codec === 'hevc' ? 'libx265 (CPU)' : 'libx264 (CPU)',
    hardware: false
  }
}

/* ------------------------------------------------------------------ *
 * Main command
 * ------------------------------------------------------------------ */

export interface BuildCommandOptions {
  result: AnalysisResult
  settings: AppSettings
  caps?: EncoderCapabilities
  outputPath: string
}

export interface BuiltCommand {
  args: string[]
  /** Encoder used for video, when re-encoding. */
  encoderLabel?: string
}

export function buildRepairCommand(options: BuildCommandOptions): BuiltCommand {
  const { result, settings, caps, outputPath } = options
  const { file, plan } = result
  const toMp4 = plan.targetContainer === 'mp4'

  // A Vulkan device for libplacebo, named so the filter graph can ask for it.
  // Global options come before the input, which is why this is decided here
  // rather than beside the filter that needs it.
  const vulkan = plan.videoTranscode?.dolbyVisionToHdr10
    ? ['-init_hw_device', 'vulkan=plexfixer', '-filter_hw_device', 'plexfixer']
    : []

  const args: string[] = [...vulkan, '-i', file.path]
  const mapped: MappedStream[] = []
  const counters: Record<'v' | 'a' | 's' | 't', number> = { v: 0, a: 0, s: 0, t: 0 }

  /* --- 1. Decide which streams survive, in output order --------------- */

  const keep = (stream: MediaStream): void => {
    const specifier = specifierFor(stream)
    if (!specifier) return
    args.push('-map', `0:${stream.index}`)
    mapped.push({ source: stream, specifier, ordinal: counters[specifier]++ })
  }

  const dropped = new Set(plan.trackChanges.filter((c) => c.drop).map((c) => c.streamIndex))

  // Embedded artwork is a still-image `video` stream as far as ffprobe is
  // concerned, and the plan never reasons about it. It is kept apart from the
  // real video tracks because every per-video option (-c:v, -vf, -tag:v,
  // -profile:v) would otherwise apply to the poster as well — tagging a JPEG
  // as `hvc1` is what makes the MP4 muxer refuse to write a header. It is
  // mapped last instead, with its own `copy` codec and `attached_pic`
  // disposition, so a repair does not quietly strip the artwork.
  const videoTracks = file.streams.filter(
    (s) => s.kind === 'video' && !isCoverArt(s) && !dropped.has(s.index)
  )
  // Matroska has no attached-picture disposition — the stream survives but
  // reads as a second video track, which is worse than leaving it out. MKV
  // cover art belongs in an attachment, which is a separate job.
  const coverTracks = toMp4
    ? file.streams.filter((s) => s.kind === 'video' && isCoverArt(s) && !dropped.has(s.index))
    : []
  const audioTracks = file.streams.filter((s) => s.kind === 'audio' && !dropped.has(s.index))
  const subtitleTracks = file.streams.filter((s) => s.kind === 'subtitle' && !dropped.has(s.index))
  const attachments = file.streams.filter((s) => s.kind === 'attachment')

  for (const stream of videoTracks) keep(stream)

  // The companion AAC track is mapped first so that clients which ignore the
  // default flag entirely still land on a track they can play.
  let compatAudioOrdinal: number | undefined
  if (plan.addCompatibilityAudio) {
    const source = file.streams.find((s) => s.index === plan.addCompatibilityAudio!.sourceStreamIndex)
    if (source) {
      args.push('-map', `0:${source.index}`)
      compatAudioOrdinal = counters.a++
    }
  }

  for (const stream of audioTracks) {
    // Backstop: the planner keeps the container as MKV when an audio codec
    // cannot live in MP4, so this should never drop anything. It exists so a
    // bad plan produces a file missing a track rather than an unplayable mux.
    if (toMp4 && !canStreamCopyIntoMp4('audio', stream.codec)) continue
    keep(stream)
  }

  for (const stream of subtitleTracks) {
    // MP4 can only carry text subtitles; anything else was already dropped by
    // the planner, but guard here so a bad plan cannot produce a broken mux.
    if (toMp4 && !canStreamCopyIntoMp4('subtitle', stream.codec)) continue
    keep(stream)
  }

  // Artwork goes last so the real video keeps output ordinal 0, which is what
  // the codec tag and the filter graph are scoped to.
  const coverOrdinals: number[] = []
  for (const stream of coverTracks) {
    keep(stream)
    coverOrdinals.push(counters.v - 1)
  }

  // Fonts and other attachments only belong in MKV.
  if (!toMp4) for (const stream of attachments) keep(stream)

  /* --- 2. Codecs ------------------------------------------------------- */

  let encoderLabel: string | undefined

  if (plan.videoTranscode) {
    const spec = plan.videoTranscode
    const choice = chooseVideoEncoder(spec.codec, spec.quality, settings, caps)
    encoderLabel = choice.label

    const filters: string[] = []

    if (spec.dolbyVisionToHdr10) {
      // libplacebo is the only thing in ffmpeg that reads a Dolby Vision RPU.
      // Without it the re-encode would produce exactly the ruined colours the
      // conversion exists to prevent, so a build that cannot run it is refused
      // rather than quietly given a plain re-encode.
      if (caps && !caps.libplacebo) {
        throw new Error(
          'Converting Dolby Vision profile 5 needs an ffmpeg with a working libplacebo filter (and a Vulkan ' +
            'device for it to run on). This one does not have both.'
        )
      }
      // First in the chain: everything after it works on BT.2020 PQ pixels.
      filters.push(DOLBY_VISION_HDR10_FILTER)
    }

    // yadif over bwdif: present in every ffmpeg build, and the quality
    // difference does not matter once the source is already interlaced SD.
    if (spec.deinterlace) filters.push('yadif=mode=0:parity=-1:deint=0')
    if (spec.scaleHeight) filters.push(`scale=-2:${spec.scaleHeight}:flags=lanczos`)

    args.push('-c:v', choice.encoder, ...choice.rateControl)

    if (spec.forceYuv420p) {
      // Hardware encoders reject 10-bit input for H.264 outright, so the
      // conversion is done in the filter graph rather than left to the encoder.
      filters.push('format=yuv420p')
    }
    if (filters.length > 0) {
      // `-vf` is every video stream; artwork must not be deinterlaced or
      // scaled, so the graph is scoped to the stream being re-encoded.
      const primary = mapped.find((entry) => entry.specifier === 'v')
      args.push(primary ? `-filter:v:${primary.ordinal}` : '-vf', filters.join(','))
    }

    if (spec.codec === 'h264') {
      args.push('-profile:v', 'high')
      // Only cap the level where the resolution can actually fit inside it —
      // Level 4.1 cannot express 4K, and ffmpeg would reject the combination.
      const primaryVideo = videoTracks[0]
      const sourceHeight = primaryVideo && primaryVideo.kind === 'video' ? primaryVideo.height : 0
      const outputHeight = spec.scaleHeight ?? sourceHeight
      if (outputHeight > 0 && outputHeight <= 1080) args.push('-level:v', '4.1')
    } else {
      args.push('-profile:v', 'main10')
    }

    if (spec.dolbyVisionToHdr10) {
      // The filter produces BT.2020 PQ, but the muxer only writes those
      // properties if they are stated: an untagged HDR10 file is displayed as
      // SDR, which looks washed out rather than obviously wrong.
      args.push('-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc')
    }
  } else {
    args.push('-c:v', 'copy')
  }

  // After the video codec, so a `-c:v <encoder>` above cannot re-encode the
  // poster, and before anything else that reads video ordinals.
  for (const ordinal of coverOrdinals) {
    args.push(`-c:v:${ordinal}`, 'copy', `-disposition:v:${ordinal}`, 'attached_pic')
  }

  args.push('-c:a', 'copy')
  if (compatAudioOrdinal != null && plan.addCompatibilityAudio) {
    const spec = plan.addCompatibilityAudio
    args.push(
      `-c:a:${compatAudioOrdinal}`,
      'aac',
      `-ac:a:${compatAudioOrdinal}`,
      String(spec.channels),
      `-b:a:${compatAudioOrdinal}`,
      `${spec.bitrateKbps}k`,
      // Keep the AAC profile at LC: HE-AAC saves bitrate but is not universal.
      `-profile:a:${compatAudioOrdinal}`,
      'aac_low'
    )
  }

  if (counters.s > 0) {
    // MP4 stores text subtitles as tx3g; MKV keeps whatever came in.
    args.push('-c:s', toMp4 ? 'mov_text' : 'copy')
  }
  if (counters.t > 0) args.push('-c:t', 'copy')

  /* --- 3. Metadata, dispositions and languages -------------------------- */

  const outputContainer = toMp4 ? 'mp4' : 'mkv'

  for (const entry of mapped) {
    const change = changeFor(plan, entry.source.index)
    const target = `${entry.specifier}:${entry.ordinal}`

    // ffmpeg copies each stream's language tag verbatim, so a code has to be
    // written explicitly whenever the output container wants another form of
    // it: MP4 wants ISO 639-2/T ("fra"), Matroska /B ("fre"). That covers a
    // planned retag and a plain container change alike.
    const language = languageForContainer(change?.setLanguage ?? entry.source.language, outputContainer)
    const current = entry.source.rawLanguage?.trim().toLowerCase()
    if (language !== UNDEFINED_LANGUAGE && (change?.setLanguage || language !== current)) {
      args.push(`-metadata:s:${target}`, `language=${language}`)
    }

    // Dispositions are copied from the source by default, so only emit an
    // override where the plan actually changes something.
    const setDefault = change?.setDefault
    const setForced = change?.setForced
    if (setDefault != null || setForced != null) {
      const flags: string[] = []
      const isDefault = setDefault ?? entry.source.disposition.default
      const isForced = setForced ?? entry.source.disposition.forced
      if (isDefault) flags.push('default')
      if (isForced) flags.push('forced')
      if (entry.source.disposition.hearingImpaired) flags.push('hearing_impaired')
      if (entry.source.disposition.visualImpaired) flags.push('visual_impaired')
      if (entry.source.disposition.commentary) flags.push('comment')
      if (entry.source.disposition.original) flags.push('original')
      args.push(`-disposition:${target}`, flags.length > 0 ? flags.join('+') : '0')
    }
  }

  if (compatAudioOrdinal != null && plan.addCompatibilityAudio) {
    const spec = plan.addCompatibilityAudio
    args.push(
      `-metadata:s:a:${compatAudioOrdinal}`,
      `language=${languageForContainer(spec.language, outputContainer)}`,
      `-metadata:s:a:${compatAudioOrdinal}`,
      `title=AAC ${spec.channels > 2 ? `${spec.channels}ch` : 'Stereo'} (PlexFixer)`,
      `-disposition:a:${compatAudioOrdinal}`,
      'default'
    )
  }

  /* --- 4. Container options -------------------------------------------- */

  // Scoped to the one video stream the plan reasoned about. A bare `-tag:v`
  // applies to every video output stream, which is how a stray still-image
  // track used to poison the whole mux.
  if (plan.videoCodecTag) {
    const primary = mapped.find((entry) => entry.specifier === 'v')
    if (primary) args.push(`-tag:v:${primary.ordinal}`, plan.videoCodecTag)
  }

  // Rewrite the level in the stream's SPS — what players and Plex read — not
  // just the copy in the MP4 header; the muxer rebuilds `avcC` from the SPS.
  // Scoped to the real video track, like the tag, so artwork is untouched.
  if (plan.videoLevel != null && !plan.videoTranscode) {
    const primary = mapped.find((entry) => entry.specifier === 'v')
    if (primary) args.push(`-bsf:v:${primary.ordinal}`, `h264_metadata=level=${h264LevelLabel(plan.videoLevel)}`)
  }

  if (toMp4) {
    // +faststart rewrites the file at the end to put the index first.
    args.push('-movflags', '+faststart')
  }

  // Chapters and global metadata carry over by default; keep them explicit so
  // the behaviour does not shift with ffmpeg versions.
  args.push('-map_metadata', '0', '-map_chapters', '0')
  // Remuxing a long file with many streams can overflow the default queue.
  args.push('-max_muxing_queue_size', '4096')

  // Name the muxer rather than letting ffmpeg infer it from the extension.
  // `.m4v` selects `ipod` — "iPod H.264 MP4" — which has no codec tag for
  // HEVC and refuses to write the header at all:
  //
  //   [ipod] Could not find tag for codec hevc in stream #0
  //
  // That is most of a modern library. `.m4v` is an ordinary MP4 container,
  // so the mp4 muxer is both correct and what the file already was.
  args.push('-f', toMp4 ? 'mp4' : 'matroska')
  args.push('-y', outputPath)

  return { args, encoderLabel }
}

/* ------------------------------------------------------------------ *
 * Subtitle extraction
 * ------------------------------------------------------------------ */

/**
 * Build one ffmpeg invocation per subtitle track to extract as a sidecar.
 *
 * Separate invocations rather than one multi-output command: a single bad
 * track then fails on its own instead of taking the others with it.
 */
export function buildSubtitleExtractCommands(
  result: AnalysisResult,
  outputStem: string
): { args: string[]; outputPath: string }[] {
  const commands: { args: string[]; outputPath: string }[] = []
  const used = new Set<string>()

  for (const entry of result.plan.extractSubtitles) {
    const parts = [entry.language]
    if (entry.forced) parts.push('forced')
    let suffix = parts.join('.')
    // Plex matches sidecars by `<stem>.<lang>[.forced].srt`; keep them unique.
    let candidate = `${outputStem}.${suffix}.srt`
    let counter = 2
    while (used.has(candidate)) {
      suffix = `${parts.join('.')}.${counter++}`
      candidate = `${outputStem}.${suffix}.srt`
    }
    used.add(candidate)

    commands.push({
      outputPath: candidate,
      args: ['-i', result.file.path, '-map', `0:${entry.streamIndex}`, '-c:s', 'srt', '-y', candidate]
    })
  }

  return commands
}
