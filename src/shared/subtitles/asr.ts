/**
 * Turning an audio track into a subtitle.
 *
 * First, the thing that has to be said plainly, because the obvious design is
 * wrong: **a language model cannot do this.** Not a cloud one and not a local
 * one. Chat endpoints take text; Ollama serves text and vision models and has
 * no speech-to-text endpoint of any kind. Asking an LLM to transcribe a film is
 * not a thing that can be attempted and fail, it is a request with nowhere to
 * send it. So "transcribe with a local model" means Whisper — specifically
 * `whisper.cpp`, a binary and a model file on your own disk — and "transcribe
 * in the cloud" means a speech endpoint, which is a different address from the
 * chat endpoint even at the same vendor. The language models come in afterwards,
 * for translation, in `llm.ts`.
 *
 * Second, the useful accident: Whisper translates as well as transcribes. Given
 * Russian audio and told to translate, it emits English directly — one pass, no
 * second model, no per-line round trip. That is a *different* route to an
 * English subtitle than transcribing and then translating, with different
 * trade-offs, and both are offered rather than one being hidden. Whisper's own
 * translation only ever goes to English; a language model will go to anything,
 * and sees the whole line in context rather than a sliding window of audio.
 */

import { languageAlpha2 } from '../languages.js'
import { parseCues, type Cue } from './cues.js'
import {
  asArray,
  asNumber,
  asRecord,
  asText,
  isProblem,
  readJson,
  type HttpReply,
  type ProviderProblem
} from './providers/types.js'
import type { SpeechInterval } from './silence.js'

/* ------------------------------------------------------------------ *
 * The audio Whisper wants
 * ------------------------------------------------------------------ */

/**
 * Whisper takes 16 kHz mono and nothing else, so everything is resampled to it.
 *
 * That is not a loss worth worrying about: speech lives below 8 kHz, and the
 * model was trained on exactly this. It is also what makes chunking arithmetic
 * simple — 16-bit mono at 16 kHz is thirty-two kilobytes a second, so a minute
 * of film is 1.92 MB and an upload limit converts straight into minutes.
 */
export const WHISPER_SAMPLE_RATE = 16_000
export const WHISPER_BYTES_PER_SECOND = WHISPER_SAMPLE_RATE * 2

/**
 * Pull one audio track out as a WAV Whisper will accept.
 *
 * `-vn` and the explicit map matter: a film has several audio tracks and the
 * one being transcribed is a deliberate choice — the original-language track,
 * not whichever dub ffmpeg would pick by itself.
 */
export function buildAudioExtractCommand(
  sourcePath: string,
  streamIndex: number,
  outputPath: string,
  window?: { startSeconds: number; durationSeconds: number }
): string[] {
  const args: string[] = []
  // Seeking before the input is the fast kind: ffmpeg jumps rather than
  // decoding its way there, which on a two-hour film is the difference between
  // a second and a minute.
  if (window) args.push('-ss', String(window.startSeconds))
  args.push('-i', sourcePath)
  if (window) args.push('-t', String(window.durationSeconds))
  args.push(
    '-vn',
    '-sn',
    '-dn',
    '-map',
    `0:${streamIndex}`,
    '-ac',
    '1',
    '-ar',
    String(WHISPER_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-y',
    outputPath
  )
  return args
}

/* ------------------------------------------------------------------ *
 * Splitting a film into pieces
 * ------------------------------------------------------------------ */

export interface AudioChunk {
  index: number
  startSeconds: number
  durationSeconds: number
}

/**
 * Where to cut a film so each piece fits inside an upload limit.
 *
 * Cuts land in silence wherever there is any, which is the whole point of
 * having run `silencedetect` already: a cut through the middle of a word gives
 * both pieces a fragment the model guesses at, and the guesses turn up in the
 * subtitle as invented sentences. Silence between sentences costs nothing.
 *
 * A cut is looked for in the last fifth of the allowance rather than at the
 * exact limit, so that a piece ends a little early at a natural break instead
 * of ending exactly on time in the middle of a line.
 */
export function planChunks(
  durationSeconds: number,
  maxChunkSeconds: number,
  speech: readonly SpeechInterval[]
): AudioChunk[] {
  if (durationSeconds <= 0) return []
  if (durationSeconds <= maxChunkSeconds) {
    return [{ index: 0, startSeconds: 0, durationSeconds }]
  }

  // The gaps between speech are where it is safe to cut.
  const silences: { startMs: number; endMs: number }[] = []
  let cursor = 0
  for (const span of [...speech].sort((a, b) => a.startMs - b.startMs)) {
    if (span.startMs > cursor) silences.push({ startMs: cursor, endMs: span.startMs })
    cursor = Math.max(cursor, span.endMs)
  }
  if (durationSeconds * 1000 > cursor) silences.push({ startMs: cursor, endMs: durationSeconds * 1000 })

  const chunks: AudioChunk[] = []
  let at = 0
  while (at < durationSeconds - 0.5) {
    const limit = Math.min(durationSeconds, at + maxChunkSeconds)
    let cut = limit

    if (limit < durationSeconds) {
      const earliest = at + maxChunkSeconds * 0.8
      // The latest silence that still leaves a piece of reasonable length.
      let found: number | undefined
      for (const silence of silences) {
        const middle = (silence.startMs + silence.endMs) / 2000
        if (middle >= earliest && middle <= limit) found = middle
      }
      if (found !== undefined) cut = found
    }

    chunks.push({ index: chunks.length, startSeconds: at, durationSeconds: Math.max(0.5, cut - at) })
    at = cut
  }

  return chunks
}

/** The longest piece an endpoint will take, in seconds, from its size limit. */
export function secondsPerUpload(maxBytes: number): number {
  // A WAV header and a safety margin: an upload refused for being eleven bytes
  // over the limit costs the whole chunk and the time spent sending it.
  return Math.max(30, Math.floor(((maxBytes - 4096) * 0.95) / WHISPER_BYTES_PER_SECOND))
}

/* ------------------------------------------------------------------ *
 * Whisper, on this machine
 * ------------------------------------------------------------------ */

export interface WhisperRun {
  /** The `whisper-cli` (or older `main`) binary. */
  binary: string
  modelPath: string
  audioPath: string
  /** Where the output goes, without an extension — Whisper adds `.srt`. */
  outputStem: string
  /** ISO 639-2/B; `und` or missing lets Whisper detect it. */
  language?: string
  /** Emit English rather than the spoken language. */
  translateToEnglish?: boolean
  threads?: number
}

/**
 * The command line for a local Whisper run.
 *
 * `-osrt` rather than reading its stdout: the SRT writer puts out properly
 * segmented cues with sensible line lengths, and scraping the progress output
 * instead would mean reimplementing that badly.
 */
export function buildWhisperCommand(run: WhisperRun): string[] {
  const args = ['-m', run.modelPath, '-f', run.audioPath, '-osrt', '-of', run.outputStem]

  const alpha2 = run.language ? languageAlpha2(run.language) : undefined
  // `auto` is Whisper's own name for "work it out from the first thirty
  // seconds", which is the right answer when the file does not say.
  args.push('-l', alpha2 ?? 'auto')
  if (run.translateToEnglish) args.push('-tr')
  if (run.threads && run.threads > 0) args.push('-t', String(run.threads))

  return args
}

/** Both names the binary has shipped under, newest first. */
export const WHISPER_BINARY_NAMES = ['whisper-cli', 'whisper', 'main'] as const

/* ------------------------------------------------------------------ *
 * A speech endpoint, somewhere else
 * ------------------------------------------------------------------ */

export interface AsrService {
  id: string
  name: string
  defaultEndpoint: string
  defaultModel: string
  /** The upload limit, which decides how the film is cut up. */
  maxUploadBytes: number
  summary: string
}

/**
 * Speech endpoints, which are all the same shape because OpenAI's was first.
 *
 * Groq is listed separately from OpenAI despite speaking the same protocol
 * because the thing worth knowing about it is not its protocol: it runs the
 * large Whisper model at a speed and a price that make transcribing a whole
 * library plausible, where OpenAI's is neither.
 */
export const ASR_SERVICES: readonly AsrService[] = [
  {
    id: 'groq',
    name: 'Groq',
    defaultEndpoint: 'https://api.groq.com/openai',
    defaultModel: 'whisper-large-v3',
    maxUploadBytes: 25 * 1024 * 1024,
    summary: 'The large Whisper model, fast and cheap enough to point at a library rather than a file.'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    defaultEndpoint: 'https://api.openai.com',
    defaultModel: 'whisper-1',
    maxUploadBytes: 25 * 1024 * 1024,
    summary: 'Whisper, hosted. Accurate and unhurried.'
  }
]

export function asrService(id: string): AsrService | undefined {
  return ASR_SERVICES.find((service) => service.id === id)
}

/**
 * A file upload, described for the native side to perform.
 *
 * The file is named by path rather than carried as bytes: a ten-minute piece of
 * audio is nineteen megabytes, and moving that through the page to be posted
 * back out again would double the memory for no reason. Rust reads it from
 * disk and streams it.
 */
export interface UploadRequest {
  url: string
  headers: Record<string, string>
  /** The form field the audio goes in. */
  fileField: string
  /** The name the file is presented under; the services use its extension. */
  fileName: string
  /** Everything else in the form. */
  fields: Record<string, string>
}

export interface AsrAsk {
  service: AsrService
  apiKey?: string
  /** Overrides the service's default endpoint when set. */
  endpoint?: string
  model?: string
  /** ISO 639-2/B of the spoken language, where it is known. */
  language?: string
  /** Emit English instead of the spoken language. */
  translateToEnglish?: boolean
  /**
   * Carried into the request as a hint about spelling.
   *
   * Names are what transcription gets wrong, consistently and everywhere, and
   * the film's own title and cast are exactly the names it will encounter.
   */
  prompt?: string
}

export function buildUpload(ask: AsrAsk, fileName: string): UploadRequest | ProviderProblem {
  if (!ask.apiKey) {
    return {
      problem: `${ask.service.name} needs an API token.`,
      hint: 'Paste one into Settings → Subtitles, or point this at a local Whisper instead.'
    }
  }

  const base = (ask.endpoint ?? ask.service.defaultEndpoint).trim().replace(/\/+$/, '')
  // Translation is a different endpoint, not a parameter, and it only ever
  // produces English.
  const path = ask.translateToEnglish ? '/v1/audio/translations' : '/v1/audio/transcriptions'

  const fields: Record<string, string> = {
    model: ask.model?.trim() || ask.service.defaultModel,
    // Segments with their own timings, rather than SRT, so the offsets of a
    // chunk can be added before anything is formatted.
    response_format: 'verbose_json'
  }
  // The translation endpoint has no language parameter: the input language is
  // detected and the output is always English.
  if (!ask.translateToEnglish) {
    const alpha2 = ask.language ? languageAlpha2(ask.language) : undefined
    if (alpha2) fields.language = alpha2
  }
  if (ask.prompt) fields.prompt = ask.prompt.slice(0, 896)

  return {
    url: `${base}${path}`,
    headers: { Authorization: `Bearer ${ask.apiKey}` },
    fileField: 'file',
    fileName,
    fields
  }
}

/**
 * Read the segments back, with a chunk's offset added.
 *
 * `offsetSeconds` is where this piece of audio started in the film. Whisper
 * reports times from the start of what it was given, so without it every chunk
 * after the first describes the first ten minutes.
 */
export function readTranscription(reply: HttpReply, offsetSeconds = 0): Cue[] | ProviderProblem {
  const parsed = readJson(reply, 'The speech endpoint')
  if (isProblem(parsed)) {
    // Some of these answer a successful transcription as plain SRT when asked,
    // and an older one ignores `response_format` entirely.
    const asSrt = parseCues(reply.text ?? '')
    if (asSrt.cues.length > 0) {
      return asSrt.cues.map((cue) => ({
        ...cue,
        startMs: cue.startMs + offsetSeconds * 1000,
        endMs: cue.endMs + offsetSeconds * 1000
      }))
    }
    return parsed
  }
  const body = asRecord(parsed)

  if (reply.status === 401 || reply.status === 403) return { problem: 'That API token was not accepted.' }
  if (reply.status === 413) {
    return {
      problem: 'That piece of audio was too large for the endpoint.',
      hint: 'Lower the chunk length under Settings → Subtitles.'
    }
  }
  if (reply.status >= 400) {
    const message = asText(asRecord(body?.error)?.message) ?? asText(body?.error)
    return { problem: message ?? `The speech endpoint returned ${reply.status}.` }
  }

  const cues: Cue[] = []
  for (const entry of asArray(body?.segments)) {
    const segment = asRecord(entry)
    const start = asNumber(segment?.start)
    const end = asNumber(segment?.end)
    const text = asText(segment?.text)
    if (start === undefined || end === undefined || !text) continue
    // Whisper pads a segment that is only silence with the same stock phrase
    // over and over — the training data's subtitle credits. One of those in a
    // subtitle is a bug report waiting to be filed.
    if (isHallucinatedFiller(text)) continue
    cues.push({
      startMs: Math.round((start + offsetSeconds) * 1000),
      endMs: Math.round((end + offsetSeconds) * 1000),
      text: text.trim()
    })
  }

  if (cues.length === 0) {
    const whole = asText(body?.text)
    if (whole && !isHallucinatedFiller(whole)) {
      // No segments, but it did hear something: one cue over the whole piece is
      // not a usable subtitle, so this is reported rather than returned.
      return { problem: 'The endpoint transcribed the audio but gave no timings for it.' }
    }
  }

  return cues
}

/**
 * Phrases Whisper emits when there is nothing to transcribe.
 *
 * Every Whisper model was trained on subtitle files, credits and all, so when
 * it is given silence or music it reaches for the most common line in its
 * training data. These turn up over end credits and under scores, in every
 * language, and they are not a mistake in the audio — they are the model
 * filling a gap. Dropping them by hand is unglamorous and there is no better
 * way to do it.
 */
const FILLER = [
  'subtitles by',
  'subtitles:',
  'subs by',
  'transcription by',
  'amara.org',
  'subtitled by',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'продолжение следует',
  'субтитры',
  'редактор субтитров',
  'корректор'
]

export function isHallucinatedFiller(text: string): boolean {
  const lower = text.trim().toLowerCase().replace(/\s+/g, ' ')
  if (lower === '') return true
  // Only short lines are judged: a real line of dialogue can mention watching
  // something, and a forty-word sentence is not stock filler.
  if (lower.length > 80) return false
  return FILLER.some((phrase) => lower.includes(phrase))
}
