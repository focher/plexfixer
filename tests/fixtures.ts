import type { AudioStream, MediaFile, SubtitleStream, VideoStream, StreamDisposition } from '@shared/types.js'

const NO_FLAGS: StreamDisposition = {
  default: false,
  forced: false,
  hearingImpaired: false,
  visualImpaired: false,
  commentary: false,
  dub: false,
  original: false,
  attachedPic: false
}

export function flags(overrides: Partial<StreamDisposition> = {}): StreamDisposition {
  return { ...NO_FLAGS, ...overrides }
}

export function video(overrides: Partial<VideoStream> = {}): VideoStream {
  return {
    index: 0,
    kind: 'video',
    codec: 'h264',
    language: 'und',
    disposition: flags({ default: true }),
    tags: {},
    width: 1920,
    height: 1080,
    profile: 'High',
    level: 40,
    pixFmt: 'yuv420p',
    bitDepth: 8,
    chromaSubsampling: '4:2:0',
    frameRate: 23.976,
    isInterlaced: false,
    isHdr: false,
    isAnamorphic: false,
    ...overrides
  }
}

/** Embedded poster artwork, which ffprobe reports as a still-image video stream. */
export function coverArt(overrides: Partial<VideoStream> = {}): VideoStream {
  return video({
    index: 9,
    codec: 'mjpeg',
    width: 600,
    height: 900,
    profile: undefined,
    level: undefined,
    frameRate: 90000,
    disposition: flags({ attachedPic: true }),
    ...overrides
  })
}

/** An audio track with no disposition flags set. */
export function audio(overrides: Partial<AudioStream> = {}): AudioStream {
  return {
    index: 1,
    kind: 'audio',
    codec: 'aac',
    language: 'eng',
    disposition: flags(),
    tags: {},
    channels: 2,
    channelLayout: 'stereo',
    sampleRate: 48000,
    ...overrides
  }
}

/** The track a well-formed file would have flagged as its default audio. */
export function mainAudio(overrides: Partial<AudioStream> = {}): AudioStream {
  return audio({ disposition: flags({ default: true }), ...overrides })
}

export function subtitle(overrides: Partial<SubtitleStream> = {}): SubtitleStream {
  return {
    index: 2,
    kind: 'subtitle',
    codec: 'subrip',
    language: 'eng',
    disposition: flags(),
    tags: {},
    isImageBased: false,
    ...overrides
  }
}

export function mkv(streams: MediaFile['streams'], overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path: '/library/Movies/Example (2020)/Example (2020).mkv',
    fileName: 'Example (2020).mkv',
    extension: 'mkv',
    sizeBytes: 8_000_000_000,
    container: 'matroska',
    formatName: 'matroska,webm',
    durationSeconds: 7200,
    bitRate: 8_800_000,
    streams,
    sidecarSubtitles: [],
    tags: {},
    ...overrides
  }
}

export function mp4(streams: MediaFile['streams'], overrides: Partial<MediaFile> = {}): MediaFile {
  return mkv(streams, {
    path: '/library/Movies/Example (2020)/Example (2020).mp4',
    fileName: 'Example (2020).mp4',
    extension: 'mp4',
    container: 'mp4',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    faststart: true,
    ...overrides
  })
}
