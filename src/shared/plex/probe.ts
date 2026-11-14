/**
 * ffprobe invocation and normalisation.
 *
 * Everything here reads through a `ProbeHost`, so the same code probes a local
 * disk, a machine across SSH, or — in the Tauri shell — a filesystem reached
 * through Rust. Nothing in it knows which.
 *
 * ffprobe's JSON is loose — fields appear and disappear per codec, numbers come
 * back as strings, and language tags live under differently-cased keys
 * depending on the container. Everything is normalised here so the analysis
 * code can work with a stable shape.
 */

import type { ProbeHost } from '../host.js'
import type {
  AudioStream,
  ContainerFormat,
  MediaFile,
  MediaStream,
  OtherStream,
  StreamDisposition,
  SubtitleStream,
  TrackKind,
  VideoStream
} from '../types.js'
import { normalizeLanguage } from '../languages.js'
import { parseH264Config, parseHexDump, type H264Config } from './h264-sps.js'
import { bitDepthFromPixFmt, chromaFromPixFmt, isImageSubtitle } from './rules.js'

/* ------------------------------------------------------------------ *
 * Raw ffprobe shapes (only the fields we read)
 * ------------------------------------------------------------------ */

interface RawDisposition {
  [key: string]: number | undefined
}

interface RawSideData {
  side_data_type?: string
  dv_profile?: number
  dv_bl_signal_compatibility_id?: number
  [key: string]: unknown
}

interface RawStream {
  index: number
  codec_type?: string
  codec_name?: string
  codec_long_name?: string
  codec_tag_string?: string
  profile?: string | number
  level?: number
  width?: number
  height?: number
  pix_fmt?: string
  field_order?: string
  refs?: number
  sample_aspect_ratio?: string
  display_aspect_ratio?: string
  color_primaries?: string
  color_transfer?: string
  color_space?: string
  channels?: number
  channel_layout?: string
  sample_rate?: string
  bit_rate?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  disposition?: RawDisposition
  tags?: Record<string, string>
  side_data_list?: RawSideData[]
}

interface RawFormat {
  format_name?: string
  duration?: string
  size?: string
  bit_rate?: string
  tags?: Record<string, string>
}

interface RawProbe {
  streams?: RawStream[]
  format?: RawFormat
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function toNumber(value: string | number | undefined): number | undefined {
  if (value == null) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** ffprobe returns frame rates as "24000/1001". */
function parseRational(value: string | undefined): number | undefined {
  if (!value) return undefined
  const [num, den] = value.split('/').map(Number)
  if (!Number.isFinite(num)) return undefined
  if (den == null || !Number.isFinite(den) || den === 0) return num
  return num / den
}

/** Tag lookup that tolerates the casing differences between containers. */
function tag(tags: Record<string, string> | undefined, ...names: string[]): string | undefined {
  if (!tags) return undefined
  const lowered = new Map(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]))
  for (const name of names) {
    const found = lowered.get(name.toLowerCase())
    if (found != null && found !== '') return found
  }
  return undefined
}

function dispositionOf(raw: RawDisposition | undefined): StreamDisposition {
  const flag = (key: string): boolean => (raw?.[key] ?? 0) === 1
  return {
    default: flag('default'),
    forced: flag('forced'),
    hearingImpaired: flag('hearing_impaired'),
    visualImpaired: flag('visual_impaired'),
    commentary: flag('comment'),
    dub: flag('dub'),
    original: flag('original'),
    attachedPic: flag('attached_pic')
  }
}

function kindOf(codecType: string | undefined): TrackKind {
  switch (codecType) {
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'subtitle':
      return 'subtitle'
    case 'attachment':
      return 'attachment'
    default:
      return 'data'
  }
}

function containerOf(formatName: string | undefined, extension: string): ContainerFormat {
  const name = (formatName ?? '').toLowerCase()
  if (name.includes('matroska') || name.includes('webm')) return 'matroska'
  if (name.includes('mp4') || name.includes('mov') || name.includes('m4v') || name.includes('3gp')) return 'mp4'
  // Fall back to the extension when ffprobe reports a generic demuxer name.
  if (extension === 'mkv') return 'matroska'
  if (extension === 'mp4' || extension === 'm4v') return 'mp4'
  return 'other'
}

/**
 * Determine whether an MP4's `moov` atom precedes `mdat`.
 *
 * ffprobe does not report this, so the top-level box chain is walked directly.
 * Only the first few boxes need reading: the answer is decided as soon as
 * either box is seen.
 */
/**
 * The same walk, over any way of reading bytes.
 *
 * Each box header is 8 or 16 bytes and the next one is a jump away, so this is
 * a handful of small reads — which is what makes it affordable across a
 * network as well as on a local disk.
 */
export async function walkBoxes(
  size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>
): Promise<boolean | undefined> {
  try {
    let offset = 0

    for (let box = 0; box < 64 && offset + 8 <= size; box++) {
      const header = await read(offset, 16)
      const bytesRead = header.length
      if (bytesRead < 8) return undefined

      // Plain `DataView` rather than `Buffer`: this walk runs in a webview as
      // well as in Node, and four bytes big-endian is four bytes big-endian.
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
      let boxSize = view.getUint32(0)
      const type = String.fromCharCode(...header.subarray(4, 8))

      if (!/^[\x20-\x7e]{4}$/.test(type)) return undefined

      let headerSize = 8
      if (boxSize === 1) {
        // 64-bit extended size follows the type.
        if (bytesRead < 16) return undefined
        const high = view.getUint32(8)
        const low = view.getUint32(12)
        boxSize = high * 2 ** 32 + low
        headerSize = 16
      } else if (boxSize === 0) {
        // Extends to end of file — nothing can follow it.
        return type === 'moov' ? true : type === 'mdat' ? false : undefined
      }

      if (type === 'moov') return true
      if (type === 'mdat') return false
      if (boxSize < headerSize) return undefined
      offset += boxSize
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Sidecar subtitles sitting next to the media file (`Movie.en.srt` etc.). */
const SIDECAR_EXTENSIONS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup'])

async function findSidecarSubtitles(filePath: string, host: ProbeHost): Promise<string[]> {
  try {
    const paths = host.paths
    const dir = paths.dirname(filePath)
    const stem = paths.basename(filePath, paths.extname(filePath)).toLowerCase()
    const entries = await host.list(dir)
    return entries
      .filter((entry) => {
        if (entry.isDirectory) return false
        const ext = paths.extname(entry.name).slice(1).toLowerCase()
        if (!SIDECAR_EXTENSIONS.has(ext)) return false
        return entry.name.toLowerCase().startsWith(stem)
      })
      .map((entry) => paths.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * Stream mapping
 * ------------------------------------------------------------------ */

function mapStream(raw: RawStream): MediaStream {
  const kind = kindOf(raw.codec_type)
  const rawLanguage = tag(raw.tags, 'language', 'LANGUAGE')
  const base = {
    index: raw.index,
    kind,
    codec: (raw.codec_name ?? 'unknown').toLowerCase(),
    codecLongName: raw.codec_long_name,
    language: normalizeLanguage(rawLanguage),
    rawLanguage,
    title: tag(raw.tags, 'title', 'TITLE', 'handler_name'),
    disposition: dispositionOf(raw.disposition),
    bitRate: toNumber(raw.bit_rate),
    tags: raw.tags ?? {}
  }

  if (kind === 'video') {
    const dovi = raw.side_data_list?.find(
      (entry) => typeof entry.side_data_type === 'string' && /dovi|dolby vision/i.test(entry.side_data_type)
    )
    const fieldOrder = raw.field_order
    const sar = raw.sample_aspect_ratio
    const video: VideoStream = {
      ...base,
      kind: 'video',
      width: raw.width ?? 0,
      height: raw.height ?? 0,
      profile: typeof raw.profile === 'string' ? raw.profile : raw.profile != null ? String(raw.profile) : undefined,
      level: raw.level && raw.level > 0 ? raw.level : undefined,
      pixFmt: raw.pix_fmt,
      bitDepth: bitDepthFromPixFmt(raw.pix_fmt),
      chromaSubsampling: chromaFromPixFmt(raw.pix_fmt),
      frameRate: parseRational(raw.avg_frame_rate) ?? parseRational(raw.r_frame_rate),
      // ffprobe reports "[0][0][0][0]" when a stream carries no codec tag at
      // all, which is normal in Matroska; treat that as absent.
      codecTag:
        raw.codec_tag_string && !/^(\[0\])+$/.test(raw.codec_tag_string) ? raw.codec_tag_string : undefined,
      fieldOrder,
      isInterlaced: fieldOrder != null && fieldOrder !== 'progressive' && fieldOrder !== 'unknown',
      colorPrimaries: raw.color_primaries,
      colorTransfer: raw.color_transfer,
      colorSpace: raw.color_space,
      isHdr:
        raw.color_transfer === 'smpte2084' ||
        raw.color_transfer === 'arib-std-b67' ||
        raw.color_primaries === 'bt2020',
      dolbyVisionProfile: dovi?.dv_profile,
      dolbyVisionBlSignalCompatibilityId: dovi?.dv_bl_signal_compatibility_id,
      refFrames: raw.refs,
      sampleAspectRatio: sar,
      isAnamorphic: sar != null && sar !== '1:1' && sar !== '0:1' && sar !== 'N/A'
    }
    return video
  }

  if (kind === 'audio') {
    const audio: AudioStream = {
      ...base,
      kind: 'audio',
      channels: raw.channels ?? 0,
      channelLayout: raw.channel_layout,
      sampleRate: toNumber(raw.sample_rate),
      profile: typeof raw.profile === 'string' ? raw.profile : undefined
    }
    return audio
  }

  if (kind === 'subtitle') {
    const subtitle: SubtitleStream = {
      ...base,
      kind: 'subtitle',
      isImageBased: isImageSubtitle(base.codec)
    }
    return subtitle
  }

  const other: OtherStream = { ...base, kind: kind === 'attachment' ? 'attachment' : 'data' }
  return other
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export class ProbeError extends Error {
  constructor(
    public readonly filePath: string,
    message: string
  ) {
    super(message)
    this.name = 'ProbeError'
  }
}

export interface ProbeOptions {
  ffprobePath: string
  /** Also look for sidecar subtitle files beside the media file. */
  includeSidecars?: boolean
  timeoutMs?: number
  /** Where the file lives and where ffprobe runs. */
  host: ProbeHost
}

/**
 * Fill in what ffprobe's summary leaves out of an H.264 stream: the real
 * reference-frame count and the level in the avcC header, read from the codec
 * configuration itself.
 *
 * It costs a second ffprobe call, so it is only made where it can change a
 * verdict — a stream labelled above Level 4.0, the lowest ceiling a setting
 * offers. Video streams only, so a Matroska file's font attachments are not
 * dumped along with it. Anything going wrong leaves the streams as they were.
 */
async function withH264Config(
  streams: MediaStream[],
  filePath: string,
  options: ProbeOptions,
  host: ProbeHost
): Promise<MediaStream[]> {
  const wanted = streams.filter(
    (stream): stream is VideoStream =>
      stream.kind === 'video' && stream.codec.toLowerCase() === 'h264' && stream.level != null && stream.level > 40
  )
  if (wanted.length === 0) return streams
  try {
    const stdout = await host.exec(
      options.ffprobePath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-select_streams',
        'v',
        '-show_entries',
        'stream=index,extradata',
        '-show_data',
        '-print_format',
        'json',
        filePath
      ],
      { maxBytes: 4 * 1024 * 1024, timeoutMs: options.timeoutMs ?? 120_000 }
    )
    const parsed = JSON.parse(stdout) as { streams?: { index: number; extradata?: string }[] }
    const configs = new Map<number, H264Config>()
    for (const entry of parsed.streams ?? []) {
      if (!entry.extradata) continue
      const config = parseH264Config(parseHexDump(entry.extradata))
      if (config) configs.set(entry.index, config)
    }
    return streams.map((stream) => {
      const config = configs.get(stream.index)
      if (!config || stream.kind !== 'video') return stream
      return {
        ...stream,
        refFrames: config.maxNumRefFrames,
        ...(config.headerLevel != null ? { headerLevel: config.headerLevel } : {})
      }
    })
  } catch {
    return streams
  }
}

export async function probeFile(filePath: string, options: ProbeOptions): Promise<MediaFile> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    // Dolby Vision lives in per-stream side data.
    '-show_entries',
    'stream_side_data_list',
    filePath
  ]

  const host = options.host

  let raw: RawProbe
  try {
    const stdout = await host.exec(options.ffprobePath, args, {
      maxBytes: 32 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 120_000
    })
    raw = JSON.parse(stdout) as RawProbe
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ProbeError(filePath, `ffprobe could not read this file: ${message.split('\n')[0]}`)
  }

  if (!raw.streams || raw.streams.length === 0) {
    throw new ProbeError(filePath, 'ffprobe reported no streams — the file may be truncated or not a media file.')
  }

  const extension = host.paths.extname(filePath).slice(1).toLowerCase()
  const formatName = raw.format?.format_name ?? ''
  const container = containerOf(formatName, extension)

  const info = await host.stat(filePath)
  const sizeBytes = toNumber(raw.format?.size) ?? info?.sizeBytes ?? 0

  return {
    path: filePath,
    fileName: host.paths.basename(filePath),
    extension,
    sizeBytes,
    modifiedMs: info?.modifiedMs,
    container,
    formatName,
    durationSeconds: toNumber(raw.format?.duration),
    bitRate: toNumber(raw.format?.bit_rate),
    faststart:
      container === 'mp4'
        ? await walkBoxes(sizeBytes, (offset, length) => host.readRange(filePath, offset, length))
        : undefined,
    streams: await withH264Config(raw.streams.map(mapStream), filePath, options, host),
    sidecarSubtitles: options.includeSidecars === false ? [] : await findSidecarSubtitles(filePath, host),
    tags: raw.format?.tags ?? {}
  }
}
