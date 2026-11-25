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
import { canStreamCopyIntoMp4, DOLBY_VISION_HDR10_FILTER, isMp4NativeSubtitle } from './rules.js'
import { UNDEFINED_LANGUAGE, languageForContainer } from '../languages.js'
import { h264LevelLabel } from './h264-level.js'
import { isCoverArt } from './tracks.js'

/** Per-type output ordinal for a mapped stream. */
interface MappedStream {
  source: MediaStream
  /** 'v' | 'a' | 's' | 't' — the ffmpeg stream-specifier letter. */
  specifier: 'v' | 'a' | 's' | 't'
  ordinal: number
  /**
   * True when this track's contents come from a file beside the input rather
   * than from the input itself — a subtitle that was read out, retimed and is
   * going back in. Everything else about it, its language and flags included,
   * still comes from the original track.
   */
  replaced?: boolean
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

/**
 * An option name limited to one video output stream: `-preset` becomes
 * `-preset:v:0`, and `-b:v` becomes `-b:v:0`. With no ordinal it is left
 * applying to every video stream, the only choice when none was mapped.
 */
export function scopeToVideo(flag: string, ordinal: number | undefined): string {
  if (ordinal == null) return flag
  return flag.endsWith(':v') ? `${flag}:${ordinal}` : `${flag}:v:${ordinal}`
}

/** `scopeToVideo` over a flat list of option/value pairs; values are untouched. */
export function scopeOptionsToVideo(options: string[], ordinal: number | undefined): string[] {
  return options.map((item, index) => (index % 2 === 0 ? scopeToVideo(item, ordinal) : item))
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
  /**
   * Subtitle tracks to take from a file instead of from the input.
   *
   * Each is an `.srt` written earlier in the run — the track read out of the
   * film, measured against the audio and shifted. The original track is still
   * what the plan reasons about; only its cues come from somewhere else, which
   * is why the stream index here is the *source* index, not an output ordinal.
   */
  retimedSubtitles?: readonly { streamIndex: number; path: string }[]
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

  // Every retimed subtitle is its own input, so each can be mapped in place of
  // the track it replaces. They come first, before any -map, because ffmpeg
  // numbers inputs in the order it is given them and a map that names an input
  // ffmpeg has not read yet is an error rather than a forward reference.
  const retimed = new Map((options.retimedSubtitles ?? []).map((entry) => [entry.streamIndex, entry.path]))
  const inputOrdinal = new Map<number, number>()
  const args: string[] = [...vulkan, '-i', file.path]
  for (const [streamIndex, path] of retimed) {
    inputOrdinal.set(streamIndex, inputOrdinal.size + 1)
    args.push('-i', path)
  }
  const mapped: MappedStream[] = []
  const counters: Record<'v' | 'a' | 's' | 't', number> = { v: 0, a: 0, s: 0, t: 0 }

  /* --- 1. Decide which streams survive, in output order --------------- */

  const keep = (stream: MediaStream): void => {
    const specifier = specifierFor(stream)
    if (!specifier) return
    const replacement = inputOrdinal.get(stream.index)
    // The retimed file holds exactly one stream, so `:0` rather than the index
    // it had in the film.
    args.push('-map', replacement === undefined ? `0:${stream.index}` : `${replacement}:0`)
    mapped.push({ source: stream, specifier, ordinal: counters[specifier]++, replaced: replacement !== undefined })
  }

  const dropped = new Set(plan.trackChanges.filter((c) => c.drop).map((c) => c.streamIndex))

  // Embedded artwork is a still-image `video` stream as far as ffprobe is
  // concerned, and the plan never reasons about it. It is kept apart from the
  // real video tracks because a bare `:v` option (-c:v, -vf, -tag:v,
  // -profile:v, -crf …) applies to the poster as well — tagging a JPEG as
  // `hvc1` makes the MP4 muxer refuse to write a header, and ffmpeg applies
  // `-profile:v high` even to a copied MJPEG stream, which it cannot parse.
  // Every video option below is therefore scoped to the real track. It is
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

    // Every encoder option is scoped to the track being re-encoded, so none of
    // them lands on cover art, which stays a stream copy.
    const primary = mapped.find((entry) => entry.specifier === 'v')
    const scoped = (flag: string): string => scopeToVideo(flag, primary?.ordinal)
    args.push(scoped('-c:v'), choice.encoder, ...scopeOptionsToVideo(choice.rateControl, primary?.ordinal))

    if (spec.forceYuv420p) {
      // Hardware encoders reject 10-bit input for H.264 outright, so the
      // conversion is done in the filter graph rather than left to the encoder.
      filters.push('format=yuv420p')
    }
    if (filters.length > 0) {
      // `-vf` is every video stream; artwork must not be deinterlaced or
      // scaled, so the graph is scoped to the stream being re-encoded.
      args.push(primary ? `-filter:v:${primary.ordinal}` : '-vf', filters.join(','))
    }

    if (spec.codec === 'h264') {
      args.push(scoped('-profile:v'), 'high')
      // Only cap the level where the resolution can actually fit inside it —
      // Level 4.1 cannot express 4K, and ffmpeg would reject the combination.
      const primaryVideo = videoTracks[0]
      const sourceHeight = primaryVideo && primaryVideo.kind === 'video' ? primaryVideo.height : 0
      const outputHeight = spec.scaleHeight ?? sourceHeight
      if (outputHeight > 0 && outputHeight <= 1080) args.push(scoped('-level:v'), '4.1')
    } else {
      args.push(scoped('-profile:v'), 'main10')
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
    // MP4 stores text subtitles as tx3g; MKV keeps whatever came in. Asking
    // for tx3g is a conversion, though, not a container note: `-c:s mov_text`
    // on a track that is *already* tx3g decodes it and encodes it again. That
    // is how a stream copy came to fail on a file whose subtitles ffmpeg had
    // written itself — tx3g in the wild carries bytes that are not valid
    // UTF-8, the decoder rejects them, and once enough have been rejected
    // ffmpeg gives up. Late, too: the error rate only passes its threshold
    // near the end, so the whole copy is thrown away after running.
    //
    // Copying leaves those bytes alone, so copy is the default and every
    // track that genuinely has to change format says so for itself.
    args.push('-c:s', 'copy')

    for (const entry of mapped) {
      if (entry.specifier !== 's') continue
      const asked = changeFor(plan, entry.source.index)?.convertSubtitleTo
      // A retimed track arrives as SRT in a file of its own, whatever the
      // original was, so what it needs is decided by where it is going.
      const incoming = entry.replaced ? 'subrip' : entry.source.codec
      const codec = toMp4
        ? isMp4NativeSubtitle(incoming)
          ? undefined
          : 'mov_text'
        : asked && asked !== 'mov_text' && asked !== incoming
          ? asked
          : undefined
      if (codec) args.push(`-c:s:${entry.ordinal}`, codec)
    }
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

    // A track's name, where one was set by hand. An empty value is a real
    // instruction — it clears a name somebody wants gone — so this tests for
    // the field being present, not for it being truthy.
    if (change?.setTitle !== undefined) {
      args.push(`-metadata:s:${target}`, `title=${change.setTitle}`)
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

  // Anything set by hand, written after the copy above so it wins over what
  // the file already said. The keys come from a closed list; nothing reaches
  // here that was not offered on the screen.
  for (const [key, value] of Object.entries(plan.metadataTags ?? {})) {
    args.push('-metadata', `${key}=${value}`)
  }
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
 * Read subtitle tracks out of a file so their cues can be measured.
 *
 * Nothing here lands beside the film: these are working files, written into a
 * scratch directory, read back as text, and replaced by the retimed versions
 * that go into the repair. They are SRT because SRT is the format the cue
 * parser and the retiming code in `@shared/subtitles` already speak.
 *
 * One invocation for however many tracks, because ffmpeg reads an input once
 * and demuxes it to as many outputs as it is given — running it per track
 * meant reading a 4.6 GB film three times to recover a few hundred kilobytes
 * of text.
 */
export function buildSubtitleReadCommand(
  sourcePath: string,
  targets: readonly { streamIndex: number; outputPath: string }[]
): string[] {
  const args = ['-i', sourcePath]
  for (const target of targets) {
    args.push('-map', `0:${target.streamIndex}`, '-c:s', 'srt', '-y', target.outputPath)
  }
  return args
}

/**
 * One ffmpeg run per track, for when the single run above has failed.
 *
 * One unconvertible track should not take the rest with it, and finding out
 * which one it was means trying them separately.
 */
export function buildSubtitleReadCommands(
  sourcePath: string,
  targets: readonly { streamIndex: number; outputPath: string }[]
): { args: string[]; outputPath: string }[] {
  return targets.map((target) => ({
    outputPath: target.outputPath,
    args: ['-i', sourcePath, '-map', `0:${target.streamIndex}`, '-c:s', 'srt', '-y', target.outputPath]
  }))
}

/* ------------------------------------------------------------------ *
 * Putting a subtitle back into the film
 * ------------------------------------------------------------------ */

/** One subtitle going into the film. */
export interface SubtitleMuxTrack {
  /** The `.srt` holding the cues. */
  subtitlePath: string
  /** The track being rewritten; left out, this one is added instead. */
  replaceStreamIndex?: number
  language: string
  /**
   * The flags the track should carry.
   *
   * Both, because `-disposition` sets the whole set rather than adding to it:
   * an incoming `.srt` carries no flags of its own, so a replacement written
   * with `forced` alone would quietly clear `default` off the track somebody
   * had chosen as their subtitle. Leaving both undefined writes no disposition
   * at all, which is right for a track being added and wrong for one being
   * replaced — so a replacement should always state them, even as false.
   */
  forced?: boolean
  default?: boolean
  title?: string
}

export interface SubtitleMuxOptions {
  mediaPath: string
  outputPath: string
  container: 'mp4' | 'mkv'
  tracks: readonly SubtitleMuxTrack[]
  /** How many subtitle tracks the film has now, before any of this. */
  subtitleCount: number
}

/**
 * One ffmpeg run that copies the film and writes subtitle tracks into it.
 *
 * `-map 0` takes everything and a negative map leaves out each track being
 * replaced — which is how a replacement is expressed to ffmpeg: there is no
 * "overwrite this stream", only "leave that one out and bring this one in".
 * Everything is a stream copy except the incoming subtitles, which are
 * reformatted only where the container demands it, so however many tracks are
 * being rewritten this costs one read and one write of the film and no
 * encoding at all. Retiming three tracks the obvious way — a run each — would
 * rewrite a 40 GB film three times.
 *
 * The new tracks go last, in the order given, so the output ordinals of
 * whatever stays do not move: that is what makes each new track's ordinal
 * something this function can work out rather than guess. Getting it wrong
 * writes one track's language onto another, which is the kind of quiet damage
 * this app exists to undo, so the count of what is already there is asked for
 * rather than inferred.
 */
export function buildSubtitleMuxCommand(options: SubtitleMuxOptions): string[] {
  const { container, tracks, subtitleCount } = options
  const args = ['-i', options.mediaPath]
  for (const track of tracks) args.push('-i', track.subtitlePath)

  args.push('-map', '0')
  for (const track of tracks) {
    if (track.replaceStreamIndex !== undefined) args.push('-map', `-0:${track.replaceStreamIndex}`)
  }
  // Input 0 is the film, so the first subtitle file is input 1.
  tracks.forEach((_, position) => args.push('-map', `${position + 1}:0`))

  args.push('-c', 'copy')
  // MP4 holds tx3g and nothing else; Matroska takes the SRT as it stands.
  if (container === 'mp4') args.push('-c:s', 'mov_text')

  const replaced = tracks.filter((track) => track.replaceStreamIndex !== undefined).length
  let ordinal = Math.max(0, subtitleCount - replaced)
  for (const track of tracks) {
    args.push(`-metadata:s:s:${ordinal}`, `language=${track.language}`)
    if (track.title !== undefined) args.push(`-metadata:s:s:${ordinal}`, `title=${track.title}`)

    if (track.forced !== undefined || track.default !== undefined) {
      const flags = [track.default ? 'default' : '', track.forced ? 'forced' : ''].filter(Boolean)
      // `0` is how ffmpeg is told "no flags"; omitting the option would leave
      // whatever the muxer defaults to instead.
      args.push(`-disposition:s:${ordinal}`, flags.length > 0 ? flags.join('+') : '0')
    }
    ordinal++
  }

  args.push(options.outputPath)
  return args
}
