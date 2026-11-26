import type { AppSettings } from './types.js'

/**
 * Shipped defaults, tuned for "plays on anything, anywhere".
 *
 * The conservative choices here (MP4 target, H.264 Level 4.1 ceiling, HEVC
 * treated as limited) exist because the failure mode they prevent — a remote
 * client silently transcoding — is invisible until someone complains about
 * buffering.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  defaultMode: 'safe-remux',

  preferredAudioLanguage: 'eng',
  preferredSubtitleLanguage: 'eng',
  fallbackAudioLanguages: ['eng'],
  assumeUndefinedIs: 'eng',
  preferForcedSubtitles: true,
  defaultSubtitleWhenForeignAudio: true,
  avoidCommentaryAsDefault: true,

  targetContainer: 'mp4',
  remuxMkvToMp4: true,
  resyncSubtitlesOnRepair: false,
  dropImageSubtitlesOnMp4: true,
  compatibilityAudio: 'add',
  // On by default: HEVC direct plays on every current Apple device, Chromecast
  // with Google TV, the Nvidia Shield and most smart TVs sold in the last few
  // years, and a modern library is mostly HEVC — treating it as incompatible
  // proposes re-encoding the bulk of a library to fix a problem its clients do
  // not have. Turn it off for a fleet that includes browsers or an older
  // streaming box.
  allowHevc: true,
  maxH264Level: 41,
  maxHeight: 2160,

  // Repairs replace the original; `keepBackups` is what makes that safe —
  // the original is moved into `.plexfixer-backups/` beside it, not deleted.
  outputPlacement: 'in-place',
  outputDirectory: '',
  keepBackups: true,
  // A week to notice a repair that went wrong, then the space comes back.
  backupRetentionDays: 7,
  outputSuffix: '.plexfixed',
  mp4Extension: 'keep',
  movieTemplate: '',
  episodeTemplate: '',

  hardwareEncoder: 'auto',
  videoQuality: 21,
  transcodeVideoCodec: 'h264',
  aacBitratePerChannel: 96,
  concurrency: 2,

  ffmpegPath: '',
  ffprobePath: '',

  // Off until a host is set: everything runs on this machine, as it always has.
  remoteEnabled: false,
  remoteHost: '',
  remotePort: 0,
  remoteKeyPath: '',
  remoteFfmpegPath: '',
  remoteFfprobePath: '',
  remoteDefaultPath: '',

  // Off by default: converting is a full re-encode that throws the Dolby
  // Vision layer away, and that is a choice to make deliberately rather than
  // one to find already made.
  dolbyVision5: 'keep',
  dolbyVision7: 'keep',

  // Empty until somebody pastes in a key of their own.
  tmdbCredential: '',

  subtitleProvider: 'opensubtitles',
  // Empty until somebody pastes in a key and an account of their own.
  openSubtitlesKey: '',
  openSubtitlesUsername: '',
  openSubtitlesPassword: '',
  // Just the preferred subtitle language until told otherwise.
  subtitleSearchLanguages: [],
  // A quarter of a second. Past that a person notices; inside it, moving the
  // file is churn.
  subtitleSyncToleranceMs: 250,

  // Local by default, because it is the one that costs nothing and sends
  // nothing anywhere. It does need a binary and a model file, and says so
  // until it has them.
  transcriptionEngine: 'whisper-local',
  whisperPath: '',
  whisperModelPath: '',
  whisperThreads: 0,
  subtitleTranscriptionEndpoint: '',
  subtitleTranscriptionCredential: '',
  subtitleTranscriptionModel: '',
  // Ten minutes: comfortably inside the 25 MB that both speech endpoints
  // accept, with room for a cut that lands late at a natural break.
  transcriptionChunkMinutes: 10,

  // Ollama for the same reason: a model on your own machine, no key, no bill.
  translationEngine: 'ollama',
  subtitleTranslationEndpoint: '',
  subtitleTranslationCredential: '',
  subtitleTranslationModel: '',
  // Forty lines is about two minutes of film — long enough for a scene to hold
  // together in one request, short enough that a batch to redo is cheap.
  translationBatchSize: 40,

  mediaExtensions: ['mkv', 'm4v', 'mp4'],
  recursive: true,

  // Every check and every repair, on. The list names what has been switched
  // off, so there is nothing to say here until someone switches something off.
  disabledModules: [],
  enabledModules: [],

  // No rules of your own until you write one.
  userModules: []
}

/** Merge persisted settings over the defaults, dropping unknown keys. */
export function withDefaults(partial: Partial<AppSettings> | undefined | null): AppSettings {
  if (!partial) return { ...DEFAULT_SETTINGS }
  const merged = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    const value = partial[key]
    if (value !== undefined && value !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(merged as any)[key] = value
    }
  }

  // Before 0.3.7 this was a boolean: "always add a stereo AAC track". It grew a
  // third answer — replace the track rather than add beside it — so the saved
  // boolean is carried across rather than dropped, which would silently turn
  // the behaviour back on for anybody who had turned it off.
  const wasABoolean = (partial as { ensureAacStereo?: unknown }).ensureAacStereo
  if (typeof wasABoolean === 'boolean' && partial.compatibilityAudio === undefined) {
    merged.compatibilityAudio = wasABoolean ? 'add' : 'off'
  }

  // 0.2.8 had one naming pattern for everything. A single pattern was a film
  // pattern in practice, so it is carried over to films rather than silently
  // dropped on the one upgrade where somebody might have set it.
  const beforeTheSplit = (partial as { filenameTemplate?: unknown }).filenameTemplate
  if (typeof beforeTheSplit === 'string' && beforeTheSplit !== '' && merged.movieTemplate === '') {
    merged.movieTemplate = beforeTheSplit
  }

  return merged
}
