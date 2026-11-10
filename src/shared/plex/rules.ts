/**
 * Plex direct-play compatibility rules.
 *
 * "Compatible" here means: a remote Plex client on a typical device can
 * *direct play* the stream — no server-side transcoding and no Direct Stream
 * remux. The tiers below are deliberately conservative, because the goal is a
 * file that plays on the worst client in a household, not the best one.
 *
 * Support tiers:
 *   universal — every mainstream Plex client, including web browsers
 *   broad     — TVs, streaming boxes and mobile apps; browsers may transcode
 *   limited   — only recent hardware; a meaningful share of clients transcode
 *   none      — effectively always transcoded, or outright unplayable
 */

export type SupportTier = 'universal' | 'broad' | 'limited' | 'none'

/* ------------------------------------------------------------------ *
 * Video
 * ------------------------------------------------------------------ */

export const VIDEO_CODEC_SUPPORT: Record<string, SupportTier> = {
  h264: 'universal',
  avc1: 'universal',
  hevc: 'limited',
  h265: 'limited',
  vp9: 'limited',
  av1: 'limited',
  mpeg4: 'limited',
  msmpeg4v3: 'none',
  msmpeg4v2: 'none',
  msmpeg4: 'none',
  mpeg2video: 'limited',
  mpeg1video: 'none',
  vc1: 'none',
  wmv1: 'none',
  wmv2: 'none',
  wmv3: 'none',
  vp8: 'none',
  theora: 'none',
  prores: 'none',
  dnxhd: 'none',
  ffv1: 'none',
  huffyuv: 'none',
  rv40: 'none',
  flv1: 'none',
  dirac: 'none'
}

/**
 * H.264 profiles that direct play. `High 10` (10-bit H.264) is the notorious
 * one: no consumer hardware decoder supports it, so every client transcodes.
 */
export const H264_SAFE_PROFILES = new Set(['baseline', 'constrained baseline', 'main', 'high'])

/** HEVC profiles with real hardware decoder coverage. */
export const HEVC_SAFE_PROFILES = new Set(['main', 'main 10'])

/**
 * Dolby Vision profiles and how they behave on non-DV clients.
 *
 * Profile 5 is single-layer ICtCp with no HDR10 fallback: on anything that
 * cannot decode DV it renders with badly skewed colours (the familiar green /
 * purple cast). Profile 7 is the dual-layer BluRay form and generally needs
 * the enhancement layer stripped. Profiles 8.1 and 8.4 carry an HDR10 or HLG
 * base layer, so they degrade cleanly.
 */
export const DOLBY_VISION_SAFE_PROFILES = new Set([8, 84, 81])

/**
 * The codec tag HEVC should carry in MP4, given the tag it has now.
 *
 * Apple clients accept HEVC in MP4 only when the parameter sets live in the
 * sample entry, which is what `hvc1` signals; `hev1` means they are in-band
 * and the file is refused. Dolby Vision uses the same pair one level up:
 * `dvh1` and `dvhe`. A DV stream retagged to `hvc1` loses its Dolby Vision
 * signalling entirely — the client decodes it as ordinary HEVC, which for a
 * profile without an HDR10 base layer means badly skewed colour. So DV keeps
 * its own family and only the in-band form is corrected.
 */
/**
 * Codec tags that mean the stream is encrypted.
 *
 * FairPlay-protected iTunes purchases carry `drmi` on video and `drms` on
 * audio, and ffprobe cannot name the codec underneath. ffmpeg cannot read
 * them either: a repair attempt fails with an error about an unsupported
 * codec, which tells the user nothing about the real cause.
 */
export const DRM_CODEC_TAGS = new Set(['drmi', 'drms', 'drma', 'drmv'])

export function isDrmProtected(codecTag: string | undefined): boolean {
  return codecTag != null && DRM_CODEC_TAGS.has(codecTag.toLowerCase())
}

export function preferredHevcTag(currentTag: string | undefined): 'hvc1' | 'dvh1' {
  const tag = currentTag?.toLowerCase()
  return tag === 'dvh1' || tag === 'dvhe' ? 'dvh1' : 'hvc1'
}

/** Pixel formats grouped by chroma subsampling. */
export function chromaFromPixFmt(pixFmt: string | undefined): '4:2:0' | '4:2:2' | '4:4:4' | 'unknown' {
  if (!pixFmt) return 'unknown'
  if (/p?444/.test(pixFmt) || pixFmt.startsWith('gbr')) return '4:4:4'
  if (/p?422/.test(pixFmt)) return '4:2:2'
  if (/p?420/.test(pixFmt) || pixFmt === 'nv12' || pixFmt === 'nv21') return '4:2:0'
  return 'unknown'
}

/** Bit depth implied by a pixel format name. */
export function bitDepthFromPixFmt(pixFmt: string | undefined): number | undefined {
  if (!pixFmt) return undefined
  const match = /(\d{1,2})(le|be)$/.exec(pixFmt)
  if (match) return Number(match[1])
  if (/p010|p210|p410/.test(pixFmt)) return 10
  if (/p016|p216|p416/.test(pixFmt)) return 16
  return 8
}

/** Human-readable H.264/HEVC level, e.g. 41 -> "4.1". */
export function formatLevel(level: number | undefined): string {
  if (level == null || level <= 0) return 'unknown'
  if (level >= 10) return `${Math.floor(level / 10)}.${level % 10}`
  return String(level)
}

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */

export const AUDIO_CODEC_SUPPORT: Record<string, SupportTier> = {
  aac: 'universal',
  mp3: 'broad',
  ac3: 'broad',
  eac3: 'broad',
  alac: 'limited',
  opus: 'limited',
  flac: 'limited',
  vorbis: 'limited',
  dts: 'limited',
  truehd: 'none',
  mlp: 'none',
  wmav1: 'none',
  wmav2: 'none',
  wmapro: 'none',
  pcm_s16le: 'none',
  pcm_s24le: 'none',
  pcm_s32le: 'none',
  pcm_bluray: 'none',
  pcm_dvd: 'none',
  cook: 'none',
  ralf: 'none',
  nellymoser: 'none'
}

/**
 * DTS sub-formats. ffprobe reports these in `profile`; the lossless variants
 * (DTS-HD MA, DTS:X) are never direct played by streaming clients.
 */
export const DTS_LOSSLESS_PROFILES = new Set(['dts-hd ma', 'dts-hd master audio', 'dts-x', 'dts:x', 'dts-hd ma + dts:x'])

/** Channel counts beyond this get downmixed or transcoded on many clients. */
export const MAX_SAFE_CHANNELS = 6

/* ------------------------------------------------------------------ *
 * Subtitles
 * ------------------------------------------------------------------ */

/**
 * Image-based subtitle formats. These cannot be converted to text on the fly,
 * so Plex burns them into the picture — which means a *full video transcode*
 * even when the video itself was perfectly compatible. The single biggest
 * cause of surprise transcoding in a Plex library.
 */
export const IMAGE_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'pgssub',
  'dvd_subtitle',
  'dvdsub',
  'dvb_subtitle',
  'dvbsub',
  'xsub',
  'hdmv_text_subtitle'
])

/** Text subtitle formats that clients can render without burn-in. */
export const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'mov_text', 'webvtt', 'text', 'ssa', 'ass', 'microdvd', 'subviewer', 'mpl2', 'jacosub', 'stl'])

/**
 * ASS/SSA carries positioning and styling that most clients cannot render, so
 * Plex burns it in rather than converting. Common in anime releases.
 */
export const STYLED_SUBTITLE_CODECS = new Set(['ass', 'ssa'])

export function isImageSubtitle(codec: string): boolean {
  return IMAGE_SUBTITLE_CODECS.has(codec.toLowerCase())
}

export function isTextSubtitle(codec: string): boolean {
  return TEXT_SUBTITLE_CODECS.has(codec.toLowerCase())
}

/* ------------------------------------------------------------------ *
 * MP4 container capability
 * ------------------------------------------------------------------ */

/** Video codecs that can be stream-copied into MP4. */
export const MP4_VIDEO_CODECS = new Set(['h264', 'hevc', 'mpeg4', 'mpeg2video', 'av1', 'vp9'])

/** Audio codecs that can be stream-copied into MP4 and still play. */
export const MP4_AUDIO_CODECS = new Set(['aac', 'ac3', 'eac3', 'mp3', 'alac', 'dts', 'opus'])

/** The only subtitle format MP4 holds that Plex clients render natively. */
export const MP4_SUBTITLE_CODECS = new Set(['mov_text'])

/**
 * Subtitle codecs that can be converted to `mov_text` during a stream copy.
 * Image formats cannot: tx3g is a text format.
 */
export const MP4_CONVERTIBLE_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'text', 'webvtt', 'ass', 'ssa'])

export function canStreamCopyIntoMp4(kind: 'video' | 'audio' | 'subtitle', codec: string): boolean {
  const normalized = codec.toLowerCase()
  if (kind === 'video') return MP4_VIDEO_CODECS.has(normalized)
  if (kind === 'audio') return MP4_AUDIO_CODECS.has(normalized)
  return MP4_SUBTITLE_CODECS.has(normalized) || MP4_CONVERTIBLE_SUBTITLE_CODECS.has(normalized)
}

/* ------------------------------------------------------------------ *
 * Lookup helpers
 * ------------------------------------------------------------------ */

export function videoCodecTier(codec: string): SupportTier {
  return VIDEO_CODEC_SUPPORT[codec.toLowerCase()] ?? 'none'
}

export function audioCodecTier(codec: string, profile?: string): SupportTier {
  const normalized = codec.toLowerCase()
  if (normalized === 'dts' && profile && DTS_LOSSLESS_PROFILES.has(profile.toLowerCase())) return 'none'
  return AUDIO_CODEC_SUPPORT[normalized] ?? 'none'
}

/** True when a tier is good enough to leave alone for remote streaming. */
export function tierIsAcceptable(tier: SupportTier, allowLimited: boolean): boolean {
  if (tier === 'universal' || tier === 'broad') return true
  if (tier === 'limited') return allowLimited
  return false
}
