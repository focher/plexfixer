/**
 * Display helpers that are pure and worth testing, so they live in shared (the
 * renderer re-exports them from `format.ts`, as it does `formatAgo`).
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** Familiar names for the video codecs ffprobe reports. */
const VIDEO_CODEC_LABEL: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4',
  vc1: 'VC-1'
}

/** "h264" -> "H.264"; unknown codecs are uppercased; no video is a dash. */
export function formatVideoCodec(codec: string | undefined): string {
  if (!codec) return '—'
  return VIDEO_CODEC_LABEL[codec.toLowerCase()] ?? codec.toUpperCase()
}

/** Familiar names for the audio codecs ffprobe reports. */
const AUDIO_CODEC_LABEL: Record<string, string> = {
  aac: 'AAC',
  ac3: 'AC3',
  eac3: 'E-AC-3',
  truehd: 'TrueHD',
  dts: 'DTS',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  alac: 'ALAC',
  vorbis: 'Vorbis',
  pcm: 'PCM'
}

/** "eac3" -> "E-AC-3"; every PCM variant is "PCM"; no audio is a dash. */
export function formatAudioCodec(codec: string | undefined): string {
  if (!codec) return '—'
  const key = codec.toLowerCase().startsWith('pcm_') ? 'pcm' : codec.toLowerCase()
  return AUDIO_CODEC_LABEL[key] ?? codec.toUpperCase()
}
