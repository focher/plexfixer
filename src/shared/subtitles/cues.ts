/**
 * The cue list: the one shape every subtitle in this app passes through.
 *
 * A subtitle track reaches PlexFixer four ways — pulled out of the film,
 * downloaded from a service, transcribed from the audio, or translated from
 * another track — and all four want the same things done to them: shifted,
 * stretched, compared against speech, written back out. So they all become a
 * list of cues first, and everything downstream is written against that one
 * type rather than against four file formats.
 *
 * Milliseconds, as integers, because that is the finest unit any of the
 * formats can express and the only one that survives a round trip. SRT writes
 * hundredths of a second in some tools and thousandths in others; ASS writes
 * hundredths. Keeping the internal unit finer than every format means nothing
 * is lost on the way in, and rounding happens once, on the way out.
 */

/** One subtitle, with the time it appears and the time it goes away. */
export interface Cue {
  /** Milliseconds from the start of the film. */
  startMs: number
  endMs: number
  /**
   * The text, with its line breaks as newlines.
   *
   * Styling that SRT itself understands (`<i>`, `<b>`, `<u>`) is kept, because
   * Plex renders it and throwing it away would flatten emphasis the author
   * meant. Everything else — ASS override blocks, positioning, karaoke timing —
   * is gone by this point: it describes where on screen the words go, which is
   * exactly what a sidecar cannot promise.
   */
  text: string
}

/** What a parse turned up, and what it had to tolerate to get there. */
export interface ParsedCues {
  cues: Cue[]
  /** The format it turned out to be. */
  format: 'srt' | 'vtt' | 'ass' | 'unknown'
  /**
   * Blocks that were skipped because they had no usable timecode.
   *
   * Reported rather than thrown: a downloaded file with three bad blocks out
   * of nine hundred is a usable subtitle, and refusing all of it over them
   * helps nobody. A file where this is most of the blocks is a different
   * matter, which is why the count is here to be judged.
   */
  skipped: number
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

/**
 * Legacy encodings by the language the subtitle claims to be in.
 *
 * Subtitle files are old. A Russian subtitle from a tracker is far more often
 * windows-1251 than UTF-8, and decoded as UTF-8 it is not merely wrong — every
 * Cyrillic byte is invalid, so the text comes out as replacement characters and
 * the file looks empty of words. There is no byte order mark and no header to
 * say so; the only hints are the bytes themselves and what language the file
 * was offered as.
 *
 * So this is a fallback list, consulted only after strict UTF-8 has already
 * failed. It cannot be wrong in the dangerous direction: a file that decodes
 * cleanly as UTF-8 never reaches it.
 */
const LEGACY_ENCODINGS: Record<string, string> = {
  rus: 'windows-1251',
  ukr: 'windows-1251',
  bul: 'windows-1251',
  srp: 'windows-1251',
  mac: 'windows-1251',
  bel: 'windows-1251',
  gre: 'windows-1253',
  ell: 'windows-1253',
  tur: 'windows-1254',
  heb: 'windows-1255',
  ara: 'windows-1256',
  pol: 'windows-1250',
  cze: 'windows-1250',
  ces: 'windows-1250',
  slo: 'windows-1250',
  slk: 'windows-1250',
  hun: 'windows-1250',
  rum: 'windows-1250',
  ron: 'windows-1250',
  hrv: 'windows-1250',
  slv: 'windows-1250',
  chi: 'gb18030',
  zho: 'gb18030',
  jpn: 'shift_jis',
  kor: 'euc-kr',
  tha: 'windows-874'
}

/** What a byte order mark at the front says the file is. */
function byteOrderMark(bytes: Uint8Array): { encoding: string; skip: number } | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', skip: 3 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', skip: 2 }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', skip: 2 }
  return undefined
}

/**
 * Turn a downloaded subtitle's bytes into text.
 *
 * In order: a byte order mark if there is one, then strict UTF-8, then the
 * legacy encoding that goes with the language it was offered as, then
 * windows-1252 — which is the one encoding that cannot fail, since every byte
 * maps to something. The result of that last step may be mojibake, and that is
 * the honest outcome: the bytes did not say what they were and nothing in the
 * file disagreed.
 *
 * `language` is the ISO 639-2/B tag the *service* said the file was in, not
 * anything read out of the file. It is a hint about which legacy codepage to
 * reach for and is used for nothing else.
 */
export function decodeSubtitleBytes(bytes: Uint8Array, language?: string): string {
  const mark = byteOrderMark(bytes)
  if (mark) {
    const body = bytes.subarray(mark.skip)
    try {
      return new TextDecoder(mark.encoding).decode(body)
    } catch {
      // A runtime without UTF-16 support is not one this app runs in, but a
      // decoder that cannot be constructed must not lose the file.
    }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Not UTF-8. Which is ordinary for a subtitle, and the reason this
    // function exists at all.
  }

  const legacy = language ? LEGACY_ENCODINGS[language.toLowerCase()] : undefined
  if (legacy) {
    try {
      return new TextDecoder(legacy).decode(bytes)
    } catch {
      // An encoding the webview does not carry; fall through to the one it
      // certainly does.
    }
  }

  return new TextDecoder('windows-1252').decode(bytes)
}

/* ------------------------------------------------------------------ *
 * Timecodes
 * ------------------------------------------------------------------ */

/**
 * `HH:MM:SS,mmm` and every variation of it these formats actually use.
 *
 * Hours are optional because WebVTT makes them optional. The separator before
 * the fraction may be a comma or a full stop because SRT says comma, WebVTT
 * says full stop, and real files of both kinds use either. The fraction may be
 * two digits (ASS) or three (everything else), and is read as a fraction of a
 * second rather than as milliseconds so that `.5` means half a second and not
 * five.
 */
const TIMECODE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/

export function parseTimecode(value: string): number | undefined {
  const match = TIMECODE.exec(value.trim())
  if (!match) return undefined
  const [, hours, minutes, seconds, fraction] = match
  const whole = Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  // "5" is five tenths, "05" is five hundredths, "005" is five thousandths.
  const fractional = fraction ? Number(fraction) / 10 ** fraction.length : 0
  return Math.round(whole * 1000 + fractional * 1000)
}

/** `HH:MM:SS,mmm`, which is the only form SRT is reliably read in. */
export function formatTimecode(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const hours = Math.floor(clamped / 3_600_000)
  const minutes = Math.floor((clamped % 3_600_000) / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  const milliseconds = clamped % 1000
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/** ASS override blocks: `{\an8}`, `{\pos(192,230)}`, `{\k45}`. */
const ASS_OVERRIDES = /\{[^}]*\}/g
/** Everything SRT does not render, which is every tag but these four. */
const UNRENDERED_TAGS = /<(?!\/?(?:i|b|u|font)\b)[^>]*>/gi

/**
 * Reduce one cue's text to what a sidecar can honestly carry.
 *
 * Positioning is the thing being dropped, and dropping it is the point: an ASS
 * subtitle places a sign translation in the top-right corner over the sign it
 * translates, and a sidecar SRT has no way to say that. Keeping the override
 * block would put `{\an8}` on screen as text. So the words survive and the
 * staging does not, which is the same trade the app already makes when it
 * writes a styled track out rather than burning it in.
 */
export function cleanCueText(raw: string): string {
  return raw
    .replace(ASS_OVERRIDES, '')
    // ASS writes its line breaks as \N (hard) and \n (soft).
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(UNRENDERED_TAGS, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** Everything before the first cue, plus the line endings, normalised away. */
function normalise(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

/**
 * Read an SRT or WebVTT file.
 *
 * The two differ in their header, their decimal separator and their optional
 * cue settings, and in nothing else that matters here — so one parser reads
 * both rather than two parsers sharing most of their code. Sequence numbers
 * are ignored entirely: they are decoration, they are wrong in plenty of real
 * files, and nothing downstream needs them.
 */
function parseSrtLike(text: string, format: 'srt' | 'vtt'): ParsedCues {
  const cues: Cue[] = []
  let skipped = 0

  for (const block of normalise(text).split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) continue
    // WebVTT's header, and the NOTE / STYLE / REGION blocks, are not cues.
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue

    const arrow = lines.findIndex((line) => line.includes('-->'))
    if (arrow < 0) {
      skipped++
      continue
    }

    const [from, to] = lines[arrow].split('-->')
    const startMs = parseTimecode(from ?? '')
    // A WebVTT cue may carry settings after the end time — `line:90% align:middle`.
    const endMs = parseTimecode((to ?? '').trim().split(/\s+/)[0] ?? '')
    if (startMs === undefined || endMs === undefined) {
      skipped++
      continue
    }

    const body = cleanCueText(lines.slice(arrow + 1).join('\n'))
    if (body === '') continue
    cues.push({ startMs, endMs, text: body })
  }

  return { cues: sortCues(cues), format, skipped }
}

/**
 * Read the dialogue out of an SSA/ASS file.
 *
 * Only the events section, and only the `Dialogue:` lines in it. The field
 * order is declared by the section's own `Format:` line rather than fixed,
 * which real files do vary, so it is read rather than assumed — and the text
 * field is last by definition, since it is the one field allowed to contain
 * commas.
 */
function parseAss(text: string): ParsedCues {
  const cues: Cue[] = []
  let skipped = 0
  let fields: string[] = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']

  for (const line of normalise(text).split('\n')) {
    const trimmed = line.trim()
    if (/^Format\s*:/i.test(trimmed)) {
      fields = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((field) => field.trim().toLowerCase())
      continue
    }
    if (!/^Dialogue\s*:/i.test(trimmed)) continue

    const startAt = fields.indexOf('start')
    const endAt = fields.indexOf('end')
    const textAt = fields.indexOf('text')
    if (startAt < 0 || endAt < 0 || textAt < 0) {
      skipped++
      continue
    }

    // Split only as far as the text field, so commas inside the text survive.
    const parts = trimmed.slice(trimmed.indexOf(':') + 1).split(',')
    const head = parts.slice(0, textAt)
    const body = parts.slice(textAt).join(',')
    const startMs = parseTimecode(head[startAt] ?? '')
    const endMs = parseTimecode(head[endAt] ?? '')
    if (startMs === undefined || endMs === undefined) {
      skipped++
      continue
    }

    const cleaned = cleanCueText(body)
    if (cleaned === '') continue
    cues.push({ startMs, endMs, text: cleaned })
  }

  return { cues: sortCues(cues), format: 'ass', skipped }
}

/**
 * Read a subtitle file of whichever kind it turns out to be.
 *
 * Sniffed from the content rather than taken from the file extension: a
 * download named `.srt` by a service is routinely an ASS file, and the
 * extension is the one piece of evidence nobody checked.
 */
export function parseCues(text: string): ParsedCues {
  const head = normalise(text).slice(0, 4096)
  if (/^\s*WEBVTT/.test(head)) return parseSrtLike(text, 'vtt')
  if (/\[Script Info\]/i.test(head) || /^\s*Dialogue\s*:/im.test(head)) return parseAss(text)
  if (head.includes('-->')) return parseSrtLike(text, 'srt')
  return { cues: [], format: 'unknown', skipped: 0 }
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Write cues out as SRT.
 *
 * SRT rather than anything richer because this is what goes beside the film:
 * every Plex client renders it without the server doing any work, which is the
 * entire reason the app prefers a sidecar to an embedded track in the first
 * place.
 */
export function formatSrt(cues: readonly Cue[]): string {
  const lines: string[] = []
  let index = 1
  for (const cue of cues) {
    if (cue.text.trim() === '') continue
    lines.push(String(index++))
    lines.push(`${formatTimecode(cue.startMs)} --> ${formatTimecode(cue.endMs)}`)
    lines.push(cue.text)
    lines.push('')
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Transforms
 * ------------------------------------------------------------------ */

/** In time order, which parsing does not guarantee and correlation requires. */
export function sortCues(cues: readonly Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

/**
 * Move every cue by the same amount.
 *
 * A cue pushed before zero is clamped rather than dropped: the words are still
 * said, and a subtitle that begins at 00:00:00 is a far smaller wrong than one
 * whose opening lines are missing. A cue whose whole span lands before zero is
 * dropped, because there is nothing left of it to show.
 */
export function shiftCues(cues: readonly Cue[], deltaMs: number): Cue[] {
  const moved: Cue[] = []
  for (const cue of cues) {
    const endMs = cue.endMs + deltaMs
    if (endMs <= 0) continue
    moved.push({ ...cue, startMs: Math.max(0, cue.startMs + deltaMs), endMs })
  }
  return moved
}

/**
 * Stretch the timeline about a fixed point.
 *
 * This is the PAL speedup and its undoing: a subtitle timed against a 25 fps
 * broadcast transfer, laid over a 23.976 fps source, drifts apart steadily
 * rather than sitting at a constant offset — by the end of a two-hour film it
 * is nearly five minutes out. A shift cannot fix that and a scale can.
 *
 * `anchorMs` is the point that does not move. Zero is right for a pure frame
 * rate conversion, where the two timelines genuinely start together.
 */
export function scaleCues(cues: readonly Cue[], factor: number, anchorMs = 0): Cue[] {
  if (!Number.isFinite(factor) || factor <= 0) return [...cues]
  const at = (ms: number): number => Math.round(anchorMs + (ms - anchorMs) * factor)
  const scaled: Cue[] = []
  for (const cue of cues) {
    const endMs = at(cue.endMs)
    if (endMs <= 0) continue
    scaled.push({ ...cue, startMs: Math.max(0, at(cue.startMs)), endMs })
  }
  return scaled
}

/**
 * The frame rate ratios worth testing when a subtitle drifts.
 *
 * Not an open search over every possible stretch: the ones that happen are
 * conversions between the four frame rates film and broadcast actually use,
 * and searching only those is both faster and far less likely to find a
 * convincing-looking ratio that is really just noise.
 */
export const FRAME_RATE_RATIOS: readonly { factor: number; label: string }[] = [
  { factor: 1, label: 'no change' },
  { factor: 25 / 23.976, label: '23.976 → 25 fps (PAL speedup)' },
  { factor: 23.976 / 25, label: '25 → 23.976 fps (PAL slowdown)' },
  { factor: 24 / 23.976, label: '23.976 → 24 fps' },
  { factor: 23.976 / 24, label: '24 → 23.976 fps' },
  { factor: 25 / 24, label: '24 → 25 fps' },
  { factor: 24 / 25, label: '25 → 24 fps' },
  { factor: 30 / 29.97, label: '29.97 → 30 fps' },
  { factor: 29.97 / 30, label: '30 → 29.97 fps' }
]

/** When the last cue goes away, which is as much of the film as it covers. */
export function cuesDurationMs(cues: readonly Cue[]): number {
  let last = 0
  for (const cue of cues) if (cue.endMs > last) last = cue.endMs
  return last
}
