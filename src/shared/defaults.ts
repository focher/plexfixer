import { setField, setParam } from './plex/catalog/edit.js'
import { DEFAULT_CATALOG } from './plex/catalog/resolve.js'
import type { CatalogPatch } from './plex/catalog/types.js'
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
  // MKV rewrapping, HEVC, the H.264 level and height ceilings, the AAC
  // companion and the subtitle switches are module parameters now: their
  // shipped values are in src/shared/plex/catalog/default.json.

  // Repairs replace the original; `keepBackups` is what makes that safe —
  // the original is moved into `.plexfixer-backups/` beside it, not deleted.
  outputPlacement: 'in-place',
  outputDirectory: '',
  keepBackups: true,
  // A week to notice a repair that went wrong, then the space comes back.
  backupRetentionDays: 7,
  outputSuffix: '.plexfixed',

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

  mediaExtensions: ['mkv', 'm4v', 'mp4'],
  recursive: true,

  // Every check and every repair, on. The list names what has been switched
  // off, so there is nothing to say here until someone switches something off.
  disabledModules: [],

  // No rules of your own until you write one.
  userModules: [],

  // Everything as shipped in default.json.
  catalog: {}
}

/**
 * Settings that used to be top-level and are now module parameters.
 *
 * A settings file written by an earlier build still has them, and they are
 * still accepted here, so nobody's tuning is lost by upgrading.
 */
export interface LegacySettings {
  remuxMkvToMp4?: boolean
  extractTextSubtitles?: boolean
  dropImageSubtitlesOnMp4?: boolean
  ensureAacStereo?: boolean
  allowHevc?: boolean
  maxH264Level?: number
  maxHeight?: number
}

/** Where each old setting went. */
const LEGACY_PARAMS: readonly {
  key: keyof LegacySettings
  section: 'checks' | 'repairs'
  id: string
  param: string
}[] = [
  { key: 'remuxMkvToMp4', section: 'checks', id: 'check.container-target', param: 'remuxMkvToMp4' },
  { key: 'extractTextSubtitles', section: 'repairs', id: 'repair.extract-subtitles', param: 'extractText' },
  { key: 'dropImageSubtitlesOnMp4', section: 'checks', id: 'check.subtitle-image', param: 'dropOnMp4' },
  { key: 'ensureAacStereo', section: 'checks', id: 'check.audio-compatible-track', param: 'addCompanion' },
  { key: 'allowHevc', section: 'checks', id: 'check.video-codec', param: 'allowHevc' },
  { key: 'maxH264Level', section: 'checks', id: 'check.video-h264-level', param: 'maxLevel' },
  { key: 'maxHeight', section: 'checks', id: 'check.video-resolution', param: 'maxHeight' }
]

/**
 * Fold the old top-level settings into the catalog patch.
 *
 * - Each old threshold becomes its module's parameter.
 * - A built-in module named in `disabledModules` becomes `enabled: false` in
 *   the catalog; rules the user wrote stay in `disabledModules`, since the
 *   catalog only knows about what ships.
 *
 * A value the catalog already sets wins — it is the newer of the two — so
 * running this again changes nothing. A value equal to the shipped default is
 * not stored at all.
 */
export function migrateSettings(raw: Partial<AppSettings> & LegacySettings): Partial<AppSettings> {
  const start = raw.catalog ?? {}
  const withParams = LEGACY_PARAMS.reduce<CatalogPatch>((patch, { key, section, id, param }) => {
    const value = raw[key]
    const already = patch[section]?.[id]?.params?.[param] !== undefined
    return value === undefined || value === null || already ? patch : setParam(patch, section, id, param, value)
  }, start)

  const builtIn = (id: string): 'checks' | 'repairs' | undefined =>
    id in DEFAULT_CATALOG.checks ? 'checks' : id in DEFAULT_CATALOG.repairs ? 'repairs' : undefined
  const disabled = raw.disabledModules ?? []
  const catalog = disabled.reduce<CatalogPatch>((patch, id) => {
    const section = builtIn(id)
    if (!section || patch[section]?.[id]?.enabled !== undefined) return patch
    return setField(patch, section, id, 'enabled', false)
  }, withParams)

  const rest = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !LEGACY_PARAMS.some((legacy) => legacy.key === key))
  ) as Partial<AppSettings>
  return {
    ...rest,
    ...(raw.disabledModules ? { disabledModules: disabled.filter((id) => builtIn(id) === undefined) } : {}),
    catalog
  }
}

/** Merge persisted settings over the defaults, folding in old ones and dropping unknown keys. */
export function withDefaults(raw: (Partial<AppSettings> & LegacySettings) | undefined | null): AppSettings {
  if (!raw) return { ...DEFAULT_SETTINGS }
  const partial = migrateSettings(raw)
  return Object.fromEntries(
    (Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]).map((key) => {
      const value = partial[key]
      return [key, value === undefined || value === null ? DEFAULT_SETTINGS[key] : value]
    })
  ) as unknown as AppSettings
}

/** Settings with some changed, old names accepted — the shape a settings file can have. */
export const settingsWith = (patch: Partial<AppSettings> & LegacySettings): AppSettings =>
  withDefaults({ ...DEFAULT_SETTINGS, ...patch })
