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
  extractTextSubtitles: true,
  dropImageSubtitlesOnMp4: true,
  ensureAacStereo: true,
  allowHevc: false,
  maxH264Level: 41,
  maxHeight: 2160,

  // Repairs replace the original; `keepBackups` is what makes that safe —
  // the original is moved into `.plexfixer-backups/` beside it, not deleted.
  outputPlacement: 'in-place',
  outputDirectory: '',
  keepBackups: true,
  outputSuffix: '.plexfixed',

  hardwareEncoder: 'auto',
  videoQuality: 21,
  transcodeVideoCodec: 'h264',
  aacBitratePerChannel: 96,
  concurrency: 2,

  ffmpegPath: '',
  ffprobePath: '',

  mediaExtensions: ['mkv', 'm4v', 'mp4'],
  recursive: true
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
  return merged
}
