/**
 * ffprobe invocation and normalisation.
 *
 * ffprobe's JSON is loose — fields appear and disappear per codec, numbers come
 * back as strings, and language tags live under differently-cased keys
 * depending on the container. Everything is normalised here so the analysis
 * code can work with a stable shape.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, extname, join } from 'node:path'
import { open, readdir, stat } from 'node:fs/promises'
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
} from '@shared/types.js'
import { normalizeLanguage } from '@shared/languages.js'
import { bitDepthFromPixFmt, chromaFromPixFmt, isImageSubtitle } from '@shared/plex/rules.js'

const execFileAsync = promisify(execFile)

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
    original: flag('original')
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
export async function hasFaststart(filePath: string): Promise<boolean | undefined> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const header = Buffer.alloc(16)
    let offset = 0
    const { size } = await handle.stat()

    for (let box = 0; box < 64 && offset + 8 <= size; box++) {
      const { bytesRead } = await handle.read(header, 0, 16, offset)
      if (bytesRead < 8) return undefined

      let boxSize = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)

      if (!/^[\x20-\x7e]{4}$/.test(type)) return undefined

      let headerSize = 8
      if (boxSize === 1) {
        // 64-bit extended size follows the type.
        if (bytesRead < 16) return undefined
        const high = header.readUInt32BE(8)
        const low = header.readUInt32BE(12)
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
  } finally {
    await handle?.close()
  }
}

/** Sidecar subtitles sitting next to the media file (`Movie.en.srt` etc.). */
const SIDECAR_EXTENSIONS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup'])

async function findSidecarSubtitles(filePath: string): Promise<string[]> {
  try {
    const dir = dirname(filePath)
    const stem = basename(filePath, extname(filePath)).toLowerCase()
    const entries = await readdir(dir)
    return entries
      .filter((entry) => {
        const ext = extname(entry).slice(1).toLowerCase()
        if (!SIDECAR_EXTENSIONS.has(ext)) return false
        return entry.toLowerCase().startsWith(stem)
      })
      .map((entry) => join(dir, entry))
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

  let raw: RawProbe
  try {
    const { stdout } = await execFileAsync(options.ffprobePath, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeoutMs ?? 120_000,
      windowsHide: true
    })
    raw = JSON.parse(stdout) as RawProbe
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ProbeError(filePath, `ffprobe could not read this file: ${message.split('\n')[0]}`)
  }

  if (!raw.streams || raw.streams.length === 0) {
    throw new ProbeError(filePath, 'ffprobe reported no streams — the file may be truncated or not a media file.')
  }

  const extension = extname(filePath).slice(1).toLowerCase()
  const formatName = raw.format?.format_name ?? ''
  const container = containerOf(formatName, extension)

  const sizeBytes = toNumber(raw.format?.size) ?? (await stat(filePath).then((s) => s.size, () => 0))

  return {
    path: filePath,
    fileName: basename(filePath),
    extension,
    sizeBytes,
    container,
    formatName,
    durationSeconds: toNumber(raw.format?.duration),
    bitRate: toNumber(raw.format?.bit_rate),
    faststart: container === 'mp4' ? await hasFaststart(filePath) : undefined,
    streams: raw.streams.map(mapStream),
    sidecarSubtitles: options.includeSidecars === false ? [] : await findSidecarSubtitles(filePath),
    tags: raw.format?.tags ?? {}
  }
}
