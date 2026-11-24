/**
 * The subtitle work itself: finding, checking, writing, transcribing,
 * translating.
 *
 * Everything under this file is pure. This is where the pure parts meet a disk,
 * a process and a network — so this is the only file in the subtitle code that
 * knows a host exists, and it is deliberately thin: each operation is a
 * sequence of calls to things that have their own tests, with the awkward parts
 * of the sequence commented rather than hidden.
 *
 * One line runs through all of it. Anything that only needs to *run* something
 * works wherever the film is, because the host runs it there — checking a
 * subtitle's timing against a film on a NAS runs ffmpeg on the NAS. Anything
 * that needs to *send* a file somewhere needs that file on this machine, and in
 * remote mode it is not. So the sync check works over SSH and transcription
 * does not, and saying that plainly is better than a feature that half works.
 */

import type { AnalysisResult, AppSettings, AudioStream } from '../types.js'
import type { RepairHost } from '../host.js'
import { normalizeLanguage, UNDEFINED_LANGUAGE } from '../languages.js'
import { sidecarLanguage } from '../plex/command.js'
import { uniquePath } from '../plex/output.js'
import { listenForSpeech } from './audio.js'
import {
  ASR_SERVICES,
  asrService,
  buildAudioExtractCommand,
  buildUpload,
  buildWhisperCommand,
  planChunks,
  readTranscription,
  secondsPerUpload,
  WHISPER_BINARY_NAMES,
  type UploadRequest
} from './asr.js'
import { decodeSubtitleBytes, formatSrt, parseCues, type Cue } from './cues.js'
import { movieHash } from './hash.js'
import { chatRequest, llmEngine, modelsRequest, readChat, readModels, type LlmModel, type LlmTarget } from './llm.js'
import { providerById, type SubtitleProvider } from './providers/index.js'
import {
  isProblem,
  type HttpReply,
  type HttpRequest,
  type ProviderCredential,
  type ProviderProblem,
  type SubtitleCandidate,
  type SubtitleQuery
} from './providers/types.js'
import type { SpeechInterval } from './silence.js'
import { analyseSync, applySync, type SyncReport } from './sync.js'
import {
  applyTranslation,
  batchOfMissing,
  planBatches,
  readBatch,
  renderBatch,
  splitBatch,
  tokenBudget,
  translationInstruction,
  type TranslationBatch
} from './translate.js'

/** The transport, which is a Tauri command on the other side of this. */
export interface SubtitleNet {
  /** `following` is set only for the second step of a download. */
  fetch: (request: HttpRequest, following?: boolean) => Promise<HttpReply>
  upload: (request: UploadRequest, filePath: string) => Promise<HttpReply>
}

/** Everything an operation needs to reach the world. */
export interface Workshop {
  host: RepairHost
  net: SubtitleNet
  settings: AppSettings
  ffmpegPath: string
  /**
   * A `whisper-cli` the native side found, when Settings does not name one.
   *
   * Settings still wins — a path somebody typed is a decision — but a build the
   * app installed itself, or one already on PATH from Homebrew, should not have
   * to be typed in to be used. Absent in tests and in any build that cannot
   * resolve one, which is the same thing as not having Whisper.
   */
  whisperPath?: string
}

/** What is going on, for a progress line that says something. */
export interface Progress {
  step: string
  /** 0..1 within this step, where there is a meaningful fraction. */
  fraction?: number
}

export type Report = (progress: Progress) => void

const noReport: Report = () => undefined

/* ------------------------------------------------------------------ *
 * Which track, and which language
 * ------------------------------------------------------------------ */

/**
 * The audio track a subtitle should be measured against.
 *
 * The film's own language, not whichever track is first and not the dub: a
 * subtitle is timed to the original performance, and an English dub of a
 * Russian film is cut differently often enough to matter. `primaryLanguage` is
 * already the app's answer to "what is this film in", so this follows it and
 * falls back to the default track only when nothing matches.
 */
export function audioTrackFor(result: AnalysisResult): AudioStream | undefined {
  const audio = result.file.streams.filter((stream): stream is AudioStream => stream.kind === 'audio')
  if (audio.length === 0) return undefined

  const primary = normalizeLanguage(result.primaryLanguage)
  const inPrimary = audio.filter((stream) => normalizeLanguage(stream.language) === primary)
  // A commentary track is in the film's language and is not the film.
  const notCommentary = inPrimary.filter((stream) => !stream.disposition.commentary)
  const candidates = notCommentary.length > 0 ? notCommentary : inPrimary

  return (
    candidates.find((stream) => stream.disposition.original) ??
    candidates[0] ??
    audio.find((stream) => stream.disposition.default) ??
    audio[0]
  )
}

/** The languages to look for: the preferred one, then anything else asked for. */
export function searchLanguages(settings: AppSettings): string[] {
  return [...new Set([settings.preferredSubtitleLanguage, ...settings.subtitleSearchLanguages].map(normalizeLanguage))]
    .filter((language) => language !== UNDEFINED_LANGUAGE)
}

/* ------------------------------------------------------------------ *
 * Finding one
 * ------------------------------------------------------------------ */

function credentialFor(provider: SubtitleProvider, settings: AppSettings): ProviderCredential {
  if (provider.id !== 'opensubtitles') return {}
  return {
    apiKey: settings.openSubtitlesKey.trim() || undefined,
    username: settings.openSubtitlesUsername.trim() || undefined,
    password: settings.openSubtitlesPassword || undefined,
    token: tokenCache.get(settings.openSubtitlesUsername.trim()) || undefined
  }
}

/**
 * Sign-in tokens, held for this run of the app and never written down.
 *
 * A token lasts about a day and a login spends nothing, so caching it in memory
 * is worth it to avoid a round trip per download; writing it to settings would
 * put a bearer token on disk beside the password that produced it, for no gain
 * over signing in again.
 */
const tokenCache = new Map<string, string>()

/** Build the query a service is asked, from what the scan knows. */
export function queryFor(result: AnalysisResult, settings: AppSettings, movieHashValue?: string): SubtitleQuery {
  const tags = result.file.tags
  const season = Number(tags.season_number ?? tags.season)
  const episode = Number(tags.episode_sort ?? tags.episode_number ?? tags.episode)
  const year = Number((tags.date ?? tags.year ?? '').slice(0, 4))

  return {
    movieHash: movieHashValue,
    sizeBytes: result.file.sizeBytes,
    // The file's own name is what a service matches a release against, and is
    // far more often right than a title guessed out of it.
    fileName: result.file.fileName,
    title: tags.title || tags.show || undefined,
    year: Number.isFinite(year) && year > 1880 ? year : undefined,
    season: Number.isFinite(season) ? season : undefined,
    episode: Number.isFinite(episode) ? episode : undefined,
    languages: searchLanguages(settings)
  }
}

export async function findSubtitles(
  shop: Workshop,
  result: AnalysisResult,
  report: Report = noReport
): Promise<SubtitleCandidate[] | ProviderProblem> {
  const provider = providerById(shop.settings.subtitleProvider)
  if (!provider) return { problem: `${shop.settings.subtitleProvider} is not a service this version knows about.` }

  report({ step: 'Working out the file’s fingerprint' })
  // Two reads of 64 KB, which identifies this exact encode. Worth doing even
  // across a share: it is the difference between a subtitle timed against this
  // file and one timed against a film of the same name.
  const hash = await movieHash(result.file.path, shop.host).catch(() => undefined)

  const request = provider.search(queryFor(result, shop.settings, hash), credentialFor(provider, shop.settings))
  if (isProblem(request)) return request

  report({ step: `Asking ${provider.name}` })
  const reply = await shop.net.fetch(request)
  return provider.readSearch(reply, queryFor(result, shop.settings, hash))
}

/**
 * Fetch one, signing in first if the service needs it and has not been asked.
 *
 * The sign-in is here rather than in the caller because it is a consequence of
 * downloading rather than a thing a person does: nobody wants a "sign in"
 * button, they want the subtitle.
 */
export async function fetchSubtitle(
  shop: Workshop,
  candidate: SubtitleCandidate,
  report: Report = noReport
): Promise<{ cues: Cue[]; text: string } | ProviderProblem> {
  const provider = providerById(candidate.provider)
  if (!provider) return { problem: `${candidate.provider} is not a service this version knows about.` }

  let credential = credentialFor(provider, shop.settings)

  const attempt = async (): Promise<HttpReply | ProviderProblem> => {
    const request = provider.download(candidate, credential)
    if (isProblem(request)) return request
    return shop.net.fetch(request)
  }

  let first = await attempt()
  // A refusal that says signing in would fix it gets exactly one attempt at
  // signing in, and then the same request again.
  if (isProblem(first) && first.needsLogin && provider.login && provider.readLogin) {
    report({ step: `Signing in to ${provider.name}` })
    const loginRequest = provider.login(credential)
    if (isProblem(loginRequest)) return loginRequest
    const loggedIn = provider.readLogin(await shop.net.fetch(loginRequest))
    if (isProblem(loggedIn)) return loggedIn
    tokenCache.set(shop.settings.openSubtitlesUsername.trim(), loggedIn.token)
    credential = { ...credential, token: loggedIn.token }
    first = await attempt()
  }
  if (isProblem(first)) return first

  report({ step: `Fetching from ${provider.name}` })
  const next = provider.readDownload(first)
  if (isProblem(next)) return next

  const bytes = 'bytes' in next ? next.bytes : (await shop.net.fetch(next.follow, true)).bytes
  if (!bytes || bytes.length === 0) return { problem: 'The subtitle came back empty.' }

  // The language the service said it is, used as the hint for which legacy
  // codepage to try — a Russian subtitle is usually windows-1251 and says so
  // nowhere in the file.
  const text = decodeSubtitleBytes(bytes, candidate.language)
  const parsed = parseCues(text)
  if (parsed.cues.length === 0) {
    return {
      problem: 'That download is not a subtitle this can read.',
      hint:
        parsed.format === 'unknown'
          ? 'It may be an archive — this version reads plain SRT, WebVTT and ASS only.'
          : undefined
    }
  }

  return { cues: parsed.cues, text }
}

/**
 * Read a subtitle that is already here — a sidecar file, or a track inside the
 * film.
 *
 * An embedded track comes out through ffmpeg rather than by parsing the
 * container: `-f srt -` converts whatever it is to SRT on standard output, so
 * one path handles SubRip, WebVTT, ASS and the MP4 `tx3g` form without this
 * file knowing the difference between them. A picture subtitle has no text to
 * convert and fails here, which is the right answer — there is nothing in it to
 * compare against speech or to translate.
 */
export async function readEmbedded(
  shop: Workshop,
  mediaPath: string,
  streamIndex: number,
  signal?: AbortSignal
): Promise<Cue[] | ProviderProblem> {
  let text: string
  try {
    text = await shop.host.exec(
      shop.ffmpegPath,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', mediaPath, '-map', `0:${streamIndex}`, '-c:s', 'srt', '-f', 'srt', '-'],
      { signal, maxBytes: 16 * 1024 * 1024 }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      problem: `That track could not be read as text: ${message}`,
      hint: 'Picture subtitles (PGS, VobSub) have no text in them to read.'
    }
  }

  const parsed = parseCues(text)
  return parsed.cues.length > 0 ? parsed.cues : { problem: 'That track came out empty.' }
}

/** Read a subtitle file sitting beside the film. */
export async function readSidecar(shop: Workshop, path: string): Promise<Cue[] | ProviderProblem> {
  const text = await readWholeFile(shop, path)
  if (text === undefined) return { problem: `${shop.host.paths.basename(path)} could not be read.` }
  const parsed = parseCues(text)
  return parsed.cues.length > 0 ? parsed.cues : { problem: `${shop.host.paths.basename(path)} has no subtitles in it.` }
}

/* ------------------------------------------------------------------ *
 * Checking the timing
 * ------------------------------------------------------------------ */

export interface TimingCheck {
  report: SyncReport
  /** The track it was measured against. */
  audioStreamIndex: number
  audioLanguage: string
  speech: SpeechInterval[]
}

/**
 * Listen to the film and see whether the subtitle follows it.
 *
 * The listening is the expensive half — a full decode of one audio track, which
 * is a minute or so for a feature — and the comparison is instant. The speech
 * it found comes back with the report so a second subtitle for the same film
 * can be checked without listening again.
 */
export async function checkTiming(
  shop: Workshop,
  result: AnalysisResult,
  cues: readonly Cue[],
  options: { speech?: readonly SpeechInterval[]; signal?: AbortSignal; report?: Report } = {}
): Promise<TimingCheck | ProviderProblem> {
  const report = options.report ?? noReport
  const track = audioTrackFor(result)
  if (!track) return { problem: 'This file has no audio to compare against.' }

  const duration = result.file.durationSeconds ?? 0
  if (duration <= 0) {
    return { problem: 'This file does not say how long it is, so there is nothing to compare against.' }
  }

  let speech = options.speech
  if (!speech) {
    report({ step: 'Listening for speech', fraction: 0 })
    try {
      speech = await listenForSpeech({
        ffmpegPath: shop.ffmpegPath,
        sourcePath: result.file.path,
        streamIndex: track.index,
        durationSeconds: duration,
        spawn: (command, args) => shop.host.spawnProcess(command, args),
        signal: options.signal,
        onAbort: () => void shop.host.kill(result.file.path).catch(() => undefined),
        onProgress: (fraction) => report({ step: 'Listening for speech', fraction })
      })
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) }
    }
  }

  report({ step: 'Comparing the lines against the speech' })
  return {
    report: analyseSync(cues, speech, duration, { toleranceMs: shop.settings.subtitleSyncToleranceMs }),
    audioStreamIndex: track.index,
    audioLanguage: normalizeLanguage(track.language),
    speech: [...speech]
  }
}

/** The cues as a timing check says they should be. */
export { applySync }

/* ------------------------------------------------------------------ *
 * Writing one out
 * ------------------------------------------------------------------ */

/**
 * Write a subtitle beside the film, under the name Plex looks for.
 *
 * `<film>.<language>[.forced].srt`, with a number appended if that name is
 * taken — never overwriting, because a file already there is somebody's:
 * downloaded, corrected by hand, or written by an earlier run. That is the same
 * rule the repair runner follows for the sidecars it extracts.
 */
export async function writeSidecar(
  shop: Workshop,
  mediaPath: string,
  cues: readonly Cue[],
  language: string,
  options: { forced?: boolean; suffix?: string } = {}
): Promise<string> {
  const paths = shop.host.paths
  const stem = paths.join(paths.dirname(mediaPath), paths.basename(mediaPath, paths.extname(mediaPath)))
  const parts = [sidecarLanguage(normalizeLanguage(language))]
  if (options.suffix) parts.push(options.suffix)
  if (options.forced) parts.push('forced')

  const target = await uniquePath(`${stem}.${parts.join('.')}.srt`, shop.host)
  const bytes = new TextEncoder().encode(formatSrt(cues))
  // Through writeRange rather than a copy: the host's write side is what works
  // both here and at the far end of an SSH connection.
  await shop.host.writeRange(target, 0, bytes)
  return target
}

/* ------------------------------------------------------------------ *
 * Writing one from the audio
 * ------------------------------------------------------------------ */

export interface TranscribeOptions {
  /** Emit English rather than the spoken language, in the one pass. */
  translateToEnglish?: boolean
  /** Reuse a speech timeline already measured for this film. */
  speech?: readonly SpeechInterval[]
  signal?: AbortSignal
  report?: Report
}

export interface Transcription {
  cues: Cue[]
  /** The language of the text produced, which is English for a translation. */
  language: string
  /** How it was produced, for the line under the result. */
  how: string
}

/** Scratch audio goes beside the film, so the read is local to wherever it is. */
function scratchPath(shop: Workshop, mediaPath: string, name: string): string {
  const paths = shop.host.paths
  return paths.join(paths.dirname(mediaPath), `.plexfixer-subtitles-${name}`)
}

export async function transcribe(
  shop: Workshop,
  result: AnalysisResult,
  options: TranscribeOptions = {}
): Promise<Transcription | ProviderProblem> {
  const report = options.report ?? noReport
  const track = audioTrackFor(result)
  if (!track) return { problem: 'This file has no audio to transcribe.' }

  const engine = shop.settings.transcriptionEngine
  const spoken = normalizeLanguage(track.language)
  const produced = options.translateToEnglish ? 'eng' : spoken

  // The line drawn at the top of this file: a hosted endpoint has to be sent
  // the audio, and audio beside a film on another machine is not here to send.
  if (engine !== 'whisper-local' && shop.host.kind === 'remote') {
    return {
      problem: 'A hosted speech endpoint needs the audio on this machine, and this film is on ' + shop.host.label + '.',
      hint: 'Transcribe with a local Whisper instead, or turn the remote host off for this file.'
    }
  }

  const written: string[] = []
  const tidy = async (): Promise<void> => {
    for (const path of written) await shop.host.remove(path).catch(() => undefined)
  }

  try {
    if (engine === 'whisper-local') {
      const outcome = await transcribeLocally(shop, result, track.index, produced, options, written, report)
      return outcome
    }
    return await transcribeRemotely(shop, result, track.index, spoken, produced, options, written, report)
  } finally {
    await tidy()
  }
}

async function transcribeLocally(
  shop: Workshop,
  result: AnalysisResult,
  streamIndex: number,
  produced: string,
  options: TranscribeOptions,
  written: string[],
  report: Report
): Promise<Transcription | ProviderProblem> {
  // Settings first, then whatever the native side resolved: a build this app
  // installed is as real as one somebody typed the path of, and asking for it
  // to be typed in anyway was the whole reason nobody got this far.
  const binary = shop.settings.whisperPath.trim() || shop.whisperPath?.trim() || ''
  const model = shop.settings.whisperModelPath.trim()
  if (!binary || !model) {
    return {
      problem: 'Local transcription needs a Whisper build and a model file.',
      hint: !binary
        ? `Settings → Subtitles can install a build and fetch a model, or point it at a ${WHISPER_BINARY_NAMES[0]} of your own.`
        : 'Settings → Subtitles can fetch a model, or point it at a ggml file of your own.'
    }
  }

  const audioPath = scratchPath(shop, result.file.path, 'audio.wav')
  written.push(audioPath)

  report({ step: 'Pulling the audio out', fraction: 0 })
  await shop.host.exec(shop.ffmpegPath, buildAudioExtractCommand(result.file.path, streamIndex, audioPath), {
    signal: options.signal,
    // ffmpeg writes a lot to stderr at the default level and none of it is
    // wanted here; a failure throws with it attached.
    maxBytes: 64 * 1024
  })

  const stem = audioPath.replace(/\.wav$/, '')
  written.push(`${stem}.srt`)

  report({ step: 'Transcribing — this is the slow part' })
  const args = buildWhisperCommand({
    binary,
    modelPath: model,
    audioPath,
    outputStem: stem,
    language: normalizeLanguage(result.primaryLanguage),
    translateToEnglish: options.translateToEnglish,
    threads: shop.settings.whisperThreads
  })

  try {
    await shop.host.exec(binary, args, { signal: options.signal, maxBytes: 256 * 1024 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      problem: `Whisper did not finish: ${message}`,
      hint: message.includes('ENOENT') || message.includes('not found') ? `Is ${binary} really there?` : undefined
    }
  }

  const srt = await readWholeFile(shop, `${stem}.srt`)
  if (srt === undefined) {
    return { problem: 'Whisper ran but wrote no subtitle file.', hint: 'Check that the model file is one it can load.' }
  }

  const parsed = parseCues(srt)
  if (parsed.cues.length === 0) return { problem: 'Whisper produced an empty subtitle.' }

  return {
    cues: parsed.cues,
    language: produced,
    how: options.translateToEnglish ? 'Transcribed and translated to English by Whisper, on this machine' : 'Transcribed by Whisper, on this machine'
  }
}

async function transcribeRemotely(
  shop: Workshop,
  result: AnalysisResult,
  streamIndex: number,
  spoken: string,
  produced: string,
  options: TranscribeOptions,
  written: string[],
  report: Report
): Promise<Transcription | ProviderProblem> {
  const service = asrService(shop.settings.transcriptionEngine)
  if (!service) {
    return { problem: `${shop.settings.transcriptionEngine} is not a speech endpoint this version knows about.` }
  }

  const duration = result.file.durationSeconds ?? 0
  if (duration <= 0) return { problem: 'This file does not say how long it is, so it cannot be cut into pieces.' }

  // Cuts want to land in silence, so the film is listened to first. It costs a
  // decode of one audio track, which is a fraction of what the uploads cost.
  let speech = options.speech
  if (!speech) {
    report({ step: 'Listening, to find where it is safe to cut', fraction: 0 })
    speech = await listenForSpeech({
      ffmpegPath: shop.ffmpegPath,
      sourcePath: result.file.path,
      streamIndex,
      durationSeconds: duration,
      spawn: (command, args) => shop.host.spawnProcess(command, args),
      signal: options.signal,
      onProgress: (fraction) => report({ step: 'Listening, to find where it is safe to cut', fraction })
    }).catch(() => [])
  }

  // Whichever is smaller: what the person asked for, and what the endpoint will
  // actually accept.
  const askedSeconds = Math.max(60, shop.settings.transcriptionChunkMinutes * 60)
  const chunkSeconds = Math.min(askedSeconds, secondsPerUpload(service.maxUploadBytes))
  const chunks = planChunks(duration, chunkSeconds, speech)

  const cues: Cue[] = []
  for (const chunk of chunks) {
    if (options.signal?.aborted) return { problem: 'Cancelled' }
    const step = `Transcribing piece ${chunk.index + 1} of ${chunks.length}`
    report({ step, fraction: chunk.index / chunks.length })

    const audioPath = scratchPath(shop, result.file.path, `chunk-${chunk.index}.wav`)
    written.push(audioPath)
    await shop.host.exec(
      shop.ffmpegPath,
      buildAudioExtractCommand(result.file.path, streamIndex, audioPath, {
        startSeconds: chunk.startSeconds,
        durationSeconds: chunk.durationSeconds
      }),
      { signal: options.signal, maxBytes: 64 * 1024 }
    )

    const upload = buildUpload(
      {
        service,
        apiKey: shop.settings.subtitleTranscriptionCredential.trim() || undefined,
        endpoint: shop.settings.subtitleTranscriptionEndpoint.trim() || undefined,
        model: shop.settings.subtitleTranscriptionModel.trim() || undefined,
        language: spoken,
        translateToEnglish: options.translateToEnglish,
        // The film's own title is exactly the sort of proper noun transcription
        // gets wrong, and the one hint these endpoints take.
        prompt: result.file.tags.title || undefined
      },
      `chunk-${chunk.index}.wav`
    )
    if (isProblem(upload)) return upload

    const piece = readTranscription(await shop.net.upload(upload, audioPath), chunk.startSeconds)
    if (isProblem(piece)) {
      // One failed piece out of twelve should not lose the other eleven, but it
      // must not be silently missing either.
      return { problem: `${step.toLowerCase()} failed: ${piece.problem}`, hint: piece.hint }
    }
    cues.push(...piece)

    await shop.host.remove(audioPath).catch(() => undefined)
  }

  if (cues.length === 0) return { problem: 'The endpoint heard nothing it could transcribe.' }

  return {
    cues,
    language: produced,
    how: `${options.translateToEnglish ? 'Transcribed and translated to English' : 'Transcribed'} by ${service.name}, in ${chunks.length} piece${chunks.length === 1 ? '' : 's'}`
  }
}

/** Read a file the host wrote, whichever machine wrote it. */
async function readWholeFile(shop: Workshop, path: string): Promise<string | undefined> {
  const stat = await shop.host.stat(path).catch(() => undefined)
  if (!stat || stat.isDirectory || stat.sizeBytes === 0) return undefined
  // A subtitle is kilobytes; this cap is only here so a wrong path cannot pull
  // something enormous into the page.
  const bytes = await shop.host.readRange(path, 0, Math.min(stat.sizeBytes, 16 * 1024 * 1024))
  return decodeSubtitleBytes(bytes)
}

/* ------------------------------------------------------------------ *
 * Translating one
 * ------------------------------------------------------------------ */

export interface Translation {
  cues: Cue[]
  /** Lines that never came back, and so kept their original text. */
  untranslated: number[]
  how: string
}

function llmTargetFor(settings: AppSettings): LlmTarget | ProviderProblem {
  const engine = llmEngine(settings.translationEngine)
  if (!engine) return { problem: `${settings.translationEngine} is not a model endpoint this version knows about.` }
  return {
    shape: engine.id,
    endpoint: settings.subtitleTranslationEndpoint.trim() || engine.defaultEndpoint,
    model: settings.subtitleTranslationModel.trim() || engine.defaultModel,
    apiKey: settings.subtitleTranslationCredential.trim() || undefined
  }
}

/** What models the chosen endpoint has, for the picker. */
export async function listTranslationModels(shop: Workshop): Promise<LlmModel[] | ProviderProblem> {
  const target = llmTargetFor(shop.settings)
  if (isProblem(target)) return target
  const request = modelsRequest(target)
  if (isProblem(request)) return request
  return readModels(target.shape, await shop.net.fetch(request))
}

/**
 * Translate a cue list, batch by batch, reconciling each one.
 *
 * A batch that does not come back whole is retried for the lines that are
 * missing, and if that fails too it is split and both halves asked for
 * separately. Only after that does a line give up and keep its original text.
 * Three attempts sounds like a lot for one batch; it is three requests out of
 * several dozen, and the alternative is a subtitle with a hole in it.
 */
export async function translate(
  shop: Workshop,
  cues: readonly Cue[],
  fromLanguage: string,
  toLanguage: string,
  options: { signal?: AbortSignal; report?: Report } = {}
): Promise<Translation | ProviderProblem> {
  const report = options.report ?? noReport
  const target = llmTargetFor(shop.settings)
  if (isProblem(target)) return target
  if (cues.length === 0) return { problem: 'There are no lines to translate.' }

  const instruction = translationInstruction(fromLanguage, toLanguage)
  const translated = new Map<number, string>()

  const ask = async (batch: TranslationBatch): Promise<ProviderProblem | undefined> => {
    const request = chatRequest(target, {
      system: instruction,
      user: renderBatch(cues, batch, translated),
      maxTokens: tokenBudget(cues, batch)
    })
    if (isProblem(request)) return request

    const answer = readChat(target.shape, await shop.net.fetch(request))
    if (isProblem(answer)) return answer

    const result = readBatch(answer, batch)
    for (const [index, line] of result.lines) translated.set(index, line)

    if (result.missing.length === 0) return undefined

    // Once for the stragglers, then split. A model that merged two lines
    // usually gets them right when asked for those two alone.
    const again = readBatch(
      (await (async () => {
        const retry = chatRequest(target, {
          system: instruction,
          user: renderBatch(cues, batchOfMissing(batch, result.missing), translated),
          maxTokens: tokenBudget(cues, batchOfMissing(batch, result.missing))
        })
        if (isProblem(retry)) return ''
        const text = readChat(target.shape, await shop.net.fetch(retry))
        return isProblem(text) ? '' : text
      })()),
      batchOfMissing(batch, result.missing)
    )
    for (const [index, line] of again.lines) translated.set(index, line)

    if (again.missing.length > 0 && batch.indexes.length > 1) {
      for (const half of splitBatch(batchOfMissing(batch, again.missing))) {
        if (half.indexes.length === batch.indexes.length) break
        const problem = await ask(half)
        if (problem) return problem
      }
    }
    return undefined
  }

  const batches = planBatches(cues, { size: shop.settings.translationBatchSize })
  for (const [index, batch] of batches.entries()) {
    if (options.signal?.aborted) return { problem: 'Cancelled' }
    report({ step: `Translating lines ${batch.indexes[0] + 1}–${batch.indexes[batch.indexes.length - 1] + 1}`, fraction: index / batches.length })
    const problem = await ask(batch)
    // A failure that is about the endpoint rather than about this batch — a
    // rejected key, a model that does not exist — will fail every batch after
    // it too, so it stops here rather than forty times over.
    if (problem) return problem
  }

  const untranslated = cues.map((_, index) => index).filter((index) => !translated.has(index))
  return {
    cues: applyTranslation(cues, translated),
    untranslated,
    how: `Translated from ${fromLanguage} to ${toLanguage} by ${target.model}`
  }
}

export { ASR_SERVICES }
