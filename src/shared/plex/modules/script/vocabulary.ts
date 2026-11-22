/**
 * Everything a hand-written rule is allowed to say.
 *
 * One table, used three times over: the parser checks a script against it, the
 * evaluator reads values through it, and the editor shows it as the list of
 * what you can write. Three copies of this would drift, and the one that
 * drifted would be the help text — so there is one.
 */

import type { MediaContext } from '../framework.js'

export type SubjectScope = 'file' | 'video' | 'audio' | 'subtitle'
export type SubjectType = 'string' | 'number' | 'boolean'

/** One value read off a file, and the track it came from when it came from one. */
export interface Reading {
  /** Absent for a question about the file as a whole. */
  streamIndex?: number
  value: string | number | boolean | undefined
}

export interface Subject {
  /** What you write in a script. */
  name: string
  scope: SubjectScope
  type: SubjectType
  /** One line, shown in the editor's list of what you can ask about. */
  describe: string
  read(context: MediaContext): Reading[]
}

const text = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

function fileSubject(
  name: string,
  type: SubjectType,
  describe: string,
  read: (context: MediaContext) => string | number | boolean | undefined
): Subject {
  return { name, scope: 'file', type, describe, read: (context) => [{ value: read(context) }] }
}

/**
 * A question about the first video track.
 *
 * Scoped to `video` rather than `file` so the finding can name the track it is
 * about, which is what puts the highlight on the right row in the UI.
 */
function videoSubject(
  name: string,
  type: SubjectType,
  describe: string,
  read: (stream: MediaContext['video'][number]) => string | number | boolean | undefined
): Subject {
  return {
    name,
    scope: 'video',
    type,
    describe,
    read: (context) => {
      const stream = context.video[0]
      return stream ? [{ streamIndex: stream.index, value: read(stream) }] : []
    }
  }
}

/** A question asked of every audio track, answered once per track. */
function audioSubject(
  name: string,
  type: SubjectType,
  describe: string,
  read: (stream: MediaContext['audio'][number]) => string | number | boolean | undefined
): Subject {
  return {
    name,
    scope: 'audio',
    type,
    describe,
    read: (context) => context.audio.map((stream) => ({ streamIndex: stream.index, value: read(stream) }))
  }
}

/** The same, for subtitle tracks. */
function subtitleSubject(
  name: string,
  type: SubjectType,
  describe: string,
  read: (stream: MediaContext['subtitles'][number]) => string | number | boolean | undefined
): Subject {
  return {
    name,
    scope: 'subtitle',
    type,
    describe,
    read: (context) => context.subtitles.map((stream) => ({ streamIndex: stream.index, value: read(stream) }))
  }
}

export const SUBJECTS: readonly Subject[] = [
  /* --- the file itself --- */
  fileSubject('container', 'string', 'mp4, matroska, or other', (c) => c.file.container),
  fileSubject('file.name', 'string', 'The file name, without the folders', (c) => c.file.fileName),
  fileSubject('file.path', 'string', 'The whole path, so a rule can apply to one folder', (c) => c.file.path),
  fileSubject('file.extension', 'string', 'mkv, mp4, m4v — lower case, no dot', (c) => c.file.extension),
  fileSubject('file.sizeBytes', 'number', 'Size in bytes', (c) => c.file.sizeBytes),
  fileSubject('file.durationSeconds', 'number', 'Running time in seconds', (c) => c.file.durationSeconds),
  fileSubject('file.bitRate', 'number', 'Overall bitrate in bits per second', (c) => c.file.bitRate),
  fileSubject('file.faststart', 'boolean', 'True when the MP4 index is already at the front', (c) => c.file.faststart),
  fileSubject('video.count', 'number', 'How many video tracks, artwork aside', (c) => c.video.length),
  fileSubject('audio.count', 'number', 'How many audio tracks', (c) => c.audio.length),
  fileSubject('subtitle.count', 'number', 'How many subtitle tracks', (c) => c.subtitles.length),

  /* --- the video --- */
  videoSubject('video.codec', 'string', 'h264, hevc, mpeg2video, vc1 …', (s) => s.codec),
  videoSubject('video.profile', 'string', 'High, Main 10, High 10 …', (s) => text(s.profile)),
  videoSubject('video.codecTag', 'string', 'The four-letter tag: avc1, hvc1, hev1 …', (s) => text(s.codecTag)),
  videoSubject('video.language', 'string', 'Three-letter language code', (s) => s.language),
  videoSubject('video.width', 'number', 'Picture width in pixels', (s) => s.width),
  videoSubject('video.height', 'number', 'Picture height in pixels', (s) => s.height),
  videoSubject('video.level', 'number', 'H.264/HEVC level, as an integer: 41 means 4.1', (s) => s.level),
  videoSubject('video.bitDepth', 'number', 'Bits per colour component: 8, 10, 12', (s) => s.bitDepth),
  videoSubject('video.frameRate', 'number', 'Frames per second', (s) => s.frameRate),
  videoSubject('video.refFrames', 'number', 'Reference frames the stream uses', (s) => s.refFrames),
  videoSubject('video.chroma', 'string', '4:2:0, 4:2:2 or 4:4:4', (s) => text(s.chromaSubsampling)),
  videoSubject('video.dolbyVision', 'number', 'Dolby Vision profile number, when there is one', (s) => s.dolbyVisionProfile),
  videoSubject('video.interlaced', 'boolean', 'True when the picture is stored as fields', (s) => s.isInterlaced),
  videoSubject('video.anamorphic', 'boolean', 'True when the pixels are not square', (s) => s.isAnamorphic),
  videoSubject('video.hdr', 'boolean', 'True when HDR10 or HLG metadata is present', (s) => s.isHdr),

  /* --- each audio track --- */
  audioSubject('audio.codec', 'string', 'aac, ac3, eac3, dts, truehd, flac …', (s) => s.codec),
  audioSubject('audio.profile', 'string', 'LC, HE-AAC, DTS-HD MA …', (s) => text(s.profile)),
  audioSubject('audio.language', 'string', 'Three-letter language code', (s) => s.language),
  audioSubject('audio.title', 'string', 'The track title, when it has one', (s) => text(s.title)),
  audioSubject('audio.channels', 'number', 'Channel count: 2 is stereo, 6 is 5.1', (s) => s.channels),
  audioSubject('audio.sampleRate', 'number', 'Samples per second', (s) => s.sampleRate),
  audioSubject('audio.default', 'boolean', 'True when the track is flagged as the default', (s) => s.disposition.default),
  audioSubject('audio.commentary', 'boolean', 'True when the track is flagged as commentary', (s) => s.disposition.commentary),

  /* --- each subtitle track --- */
  subtitleSubject('subtitle.codec', 'string', 'subrip, ass, mov_text, hdmv_pgs_subtitle …', (s) => s.codec),
  subtitleSubject('subtitle.language', 'string', 'Three-letter language code', (s) => s.language),
  subtitleSubject('subtitle.title', 'string', 'The track title, when it has one', (s) => text(s.title)),
  subtitleSubject('subtitle.image', 'boolean', 'True for picture subtitles (PGS, VobSub)', (s) => s.isImageBased),
  subtitleSubject('subtitle.default', 'boolean', 'True when the track comes up on its own', (s) => s.disposition.default),
  subtitleSubject('subtitle.forced', 'boolean', 'True when the track is flagged forced', (s) => s.disposition.forced),
  subtitleSubject(
    'subtitle.hearingImpaired',
    'boolean',
    'True when the track is flagged SDH',
    (s) => s.disposition.hearingImpaired
  )
]

/**
 * `tag.<name>`: one of the file's own metadata tags, matched without regard to
 * case. Open-ended rather than listed, because a tag is whatever wrote the file
 * chose to call it — which is how a repair script marks a file as done, so a
 * rule can stop asking for it once it has been.
 */
const tagSubject = (name: string): Subject | undefined => {
  const key = name.slice('tag.'.length).toLowerCase()
  if (!name.toLowerCase().startsWith('tag.') || !/^[a-z0-9_.-]+$/.test(key)) return undefined
  return fileSubject(`tag.${key}`, 'string', `The file's "${key}" metadata tag`, (c) =>
    Object.entries(c.file.tags).find(([tag]) => tag.toLowerCase() === key)?.[1]
  )
}

export function subjectNamed(name: string): Subject | undefined {
  return SUBJECTS.find((subject) => subject.name === name.toLowerCase()) ?? tagSubject(name)
}

/* ------------------------------------------------------------------ *
 * Operators
 * ------------------------------------------------------------------ */

export interface Operator {
  /** What you write. Longest match wins, so "is not" beats "is". */
  name: string
  /** Which kinds of value it can be used on. */
  types: readonly SubjectType[]
  /** Several values, separated by commas. */
  list?: boolean
  describe: string
}

export const OPERATORS: readonly Operator[] = [
  { name: 'is not', types: ['string', 'number', 'boolean'], describe: 'Not equal to' },
  { name: 'is', types: ['string', 'number', 'boolean'], describe: 'Equal to; text ignores capitals' },
  { name: 'not in', types: ['string', 'number'], list: true, describe: 'None of a comma-separated list' },
  { name: 'in', types: ['string', 'number'], list: true, describe: 'Any of a comma-separated list' },
  { name: 'contains', types: ['string'], describe: 'Text appears anywhere in the value' },
  { name: 'at least', types: ['number'], describe: 'Greater than or equal to' },
  { name: 'at most', types: ['number'], describe: 'Less than or equal to' },
  { name: 'above', types: ['number'], describe: 'Greater than' },
  { name: 'below', types: ['number'], describe: 'Less than' },
  { name: 'is set', types: ['string', 'number'], describe: 'The file says something, rather than nothing' },
  { name: 'is missing', types: ['string', 'number'], describe: 'The file says nothing at all' }
]

/** Longest first, so "is not" is found before "is". */
export const OPERATORS_BY_LENGTH: readonly Operator[] = [...OPERATORS].sort(
  (a, b) => b.name.length - a.name.length
)

/* ------------------------------------------------------------------ *
 * What a rule may ask for
 * ------------------------------------------------------------------ */

export type FixName = 'transcode-video' | 'remux' | 'drop-track' | 'extract-subtitles'

export interface FixOption {
  name: FixName
  describe: string
  /** The kinds of track this fix needs the rule to have matched. */
  needs?: readonly SubjectScope[]
}

export const FIXES: readonly FixOption[] = [
  {
    name: 'transcode-video',
    describe: 'Re-encode the video, using the codec and quality set under Transcoding'
  },
  { name: 'remux', describe: 'Rewrite the file with every stream copied — no re-encoding' },
  {
    name: 'drop-track',
    describe: 'Leave the matched tracks out of the repaired file',
    needs: ['audio', 'subtitle']
  },
  {
    name: 'extract-subtitles',
    describe: 'Write the matched subtitle tracks out as .srt files beside the video',
    needs: ['subtitle']
  }
]

export function fixNamed(name: string): FixOption | undefined {
  return FIXES.find((fix) => fix.name === name.toLowerCase())
}

export const SEVERITIES = ['info', 'warning', 'blocker'] as const
export type ScriptSeverity = (typeof SEVERITIES)[number]
