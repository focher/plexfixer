/**
 * Shared domain types for PlexFixer.
 *
 * These are used by the main process (analysis + job execution), the preload
 * bridge and the renderer. Keep this file dependency-free so the pure analysis
 * code in `src/shared/plex` stays unit-testable outside Electron.
 */

/* ------------------------------------------------------------------ *
 * Probe results (normalised ffprobe output)
 * ------------------------------------------------------------------ */

export type TrackKind = 'video' | 'audio' | 'subtitle' | 'attachment' | 'data'

export interface StreamDisposition {
  default: boolean
  forced: boolean
  hearingImpaired: boolean
  visualImpaired: boolean
  commentary: boolean
  /** ffprobe `dub` flag — often used for alternate-language dubs. */
  dub: boolean
  original: boolean
  /** Embedded artwork (a poster muxed in as a still-image video stream). */
  attachedPic: boolean
}

export interface BaseStream {
  /** ffprobe stream index, i.e. the `0:<index>` specifier. */
  index: number
  kind: TrackKind
  codec: string
  codecLongName?: string
  /** Normalised ISO 639-2/B three-letter tag, or `und` when missing. */
  language: string
  /** Raw language tag exactly as stored in the file (may be absent). */
  rawLanguage?: string
  title?: string
  disposition: StreamDisposition
  bitRate?: number
  /** Per-stream tags we keep for display / round-tripping. */
  tags: Record<string, string>
}

export interface VideoStream extends BaseStream {
  kind: 'video'
  width: number
  height: number
  /** e.g. "High", "Main 10", "High 10" */
  profile?: string
  /** ffprobe `level`, raw integer form: 41 means Level 4.1 */
  level?: number
  pixFmt?: string
  /** Bits per colour component, derived from pixFmt when absent. */
  bitDepth?: number
  chromaSubsampling?: '4:2:0' | '4:2:2' | '4:4:4' | 'unknown'
  frameRate?: number
  /** MP4 codec tag, e.g. `hvc1` / `hev1` / `avc1`. Critical for Apple clients. */
  codecTag?: string
  fieldOrder?: string
  isInterlaced: boolean
  colorPrimaries?: string
  colorTransfer?: string
  colorSpace?: string
  /** True when HDR10 / HLG static metadata is present. */
  isHdr: boolean
  /** Dolby Vision profile when a DV configuration record is present. */
  dolbyVisionProfile?: number
  dolbyVisionBlSignalCompatibilityId?: number
  /**
   * Reference frames the stream uses: `max_num_ref_frames` from its SPS when
   * that could be read, otherwise ffprobe's own figure.
   */
  refFrames?: number
  /**
   * H.264 only: the level in the MP4/Matroska `avcC` header, a separate copy
   * of the one in the SPS. Tools such as Subler show this one; decoders and
   * Plex read the SPS, which is `level`.
   */
  headerLevel?: number
  /** Non-square pixels (anamorphic). */
  sampleAspectRatio?: string
  isAnamorphic: boolean
}

export interface AudioStream extends BaseStream {
  kind: 'audio'
  channels: number
  channelLayout?: string
  sampleRate?: number
  /** e.g. "LC", "HE-AAC", "DTS-HD MA" */
  profile?: string
}

export interface SubtitleStream extends BaseStream {
  kind: 'subtitle'
  /** Image-based subtitles (PGS/VobSub) cannot be direct-played. */
  isImageBased: boolean
}

export interface OtherStream extends BaseStream {
  kind: 'attachment' | 'data'
}

export type MediaStream = VideoStream | AudioStream | SubtitleStream | OtherStream

export type ContainerFormat = 'matroska' | 'mp4' | 'other'

export interface MediaFile {
  path: string
  fileName: string
  /** Lowercased extension without the dot. */
  extension: string
  sizeBytes: number
  /** File modification time when probed; a stored scan is stale once it differs. */
  modifiedMs?: number
  container: ContainerFormat
  /** Raw ffprobe `format_name`, e.g. "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2". */
  formatName: string
  durationSeconds?: number
  bitRate?: number
  /** True when the MP4 `moov` atom precedes `mdat` (required for streaming). */
  faststart?: boolean
  streams: MediaStream[]
  tags: Record<string, string>
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

/**
 * How badly a finding hurts streaming to a remote Plex client.
 *
 * - `blocker`  : forces a full video transcode, or outright fails, on most clients
 * - `warning`  : direct play fails on a meaningful subset of clients
 * - `info`     : metadata / cosmetic; no transcode impact
 */
export type Severity = 'blocker' | 'warning' | 'info'

/**
 * What it would take to resolve the finding.
 *
 * - `lossless`  : container/metadata only — stream copy, seconds to run
 * - `transcode` : requires re-encoding a video or audio stream
 * - `manual`    : needs a human decision or external tooling
 * - `none`      : nothing to do (informational)
 */
export type RemedyClass = 'lossless' | 'transcode' | 'manual' | 'none'

export type FindingCode =
  | 'drm-protected'
  // container
  | 'container-not-mp4'
  | 'mp4-not-faststart'
  | 'container-unsupported'
  | 'container-blocked-by-stream'
  // video
  | 'video-codec-unsupported'
  | 'video-codec-limited'
  | 'video-high10-profile'
  | 'video-level-too-high'
  | 'video-chroma-unsupported'
  | 'video-interlaced'
  | 'video-hevc-wrong-tag'
  | 'video-dolby-vision-profile'
  | 'video-resolution-high'
  | 'video-anamorphic'
  | 'video-refframes-high'
  | 'video-missing'
  | 'video-multiple'
  // audio
  | 'audio-codec-unsupported'
  | 'audio-codec-limited'
  | 'audio-channels-high'
  | 'audio-no-compatible-track'
  | 'audio-missing'
  // subtitles
  | 'subtitle-image-based'
  | 'subtitle-image-default'
  | 'subtitle-styled-ass'
  | 'subtitle-unsupported-in-mp4'
  // tracks / language metadata
  | 'language-missing'
  | 'language-nonstandard'
  | 'default-audio-missing'
  | 'default-audio-multiple'
  | 'default-audio-language-mismatch'
  | 'default-subtitle-multiple'
  | 'default-subtitle-unwanted'
  | 'default-subtitle-language-mismatch'
  | 'forced-subtitle-not-flagged'
  | 'preferred-audio-language-absent'
  // what the file says about itself
  | 'metadata-missing'
  /**
   * Anything a rule the user wrote reported.
   *
   * One code for all of them rather than a code each: a code is how the rest
   * of the app recognises a finding it has built-in knowledge about, and there
   * is none to have about a rule written this morning.
   */
  | 'custom'

export interface Finding {
  code: FindingCode
  severity: Severity
  remedy: RemedyClass
  /** Short human-readable headline. */
  title: string
  /** Why this matters for remote streaming. */
  detail: string
  /** Stream indexes this finding refers to, when applicable. */
  streamIndexes?: number[]
}

/* ------------------------------------------------------------------ *
 * Repair plan
 * ------------------------------------------------------------------ */

export type PlanStrategy =
  /** Nothing to do. */
  | 'none'
  /** Container/metadata rewrite with `-c copy`. */
  | 'remux'
  /** Stream copy for video, re-encode of one or more audio tracks. */
  | 'transcode-audio'
  /** Re-encode video (and whatever else is needed). */
  | 'transcode-video'

export interface TrackPlanChange {
  streamIndex: number
  kind: TrackKind
  /** Language to write, when it differs from what is in the file. */
  setLanguage?: string
  /**
   * Track name to write.
   *
   * Only ever set by hand: nothing in the rules has an opinion about what a
   * track should be called. Unlike a language or a flag it is not a
   * fixed-width field, so writing one means rewriting the file.
   */
  setTitle?: string
  setDefault?: boolean
  setForced?: boolean
  /** Stream is dropped from the output entirely. */
  drop?: boolean
  /**
   * Rewrite this subtitle track in another format on the way through.
   *
   * The one lossy thing a stream copy does, and deliberately narrow: `srt` for
   * a styled track whose fonts and positioning no client can reproduce, and
   * `mov_text` for a text track MP4 would otherwise have nowhere to put. The
   * words survive; the styling does not. The point of it is that the track
   * stays in the file rather than becoming a second file beside it.
   */
  convertSubtitleTo?: 'srt' | 'mov_text'
  /**
   * Retime this subtitle track against the audio while the file is open.
   *
   * Only ever set for a text subtitle, and only when the measurement found a
   * constant offset or a drift worth correcting. The shift and stretch
   * themselves are not here: they are measured during the run, because the
   * speech has to be found first and that takes longer than planning does.
   */
  resync?: boolean
  /** Reason shown in the UI next to the change. */
  reason: string
}

export interface PlanAction {
  /** Short label, e.g. "Remux to MP4" or "Re-encode audio track 2 to AAC 5.1". */
  label: string
  detail: string
}

/**
 * Add a universally-compatible AAC track alongside the existing audio.
 *
 * The originals are kept, so nothing is lost; the new track exists purely so
 * that clients without a TrueHD/DTS-HD/FLAC decoder have something to direct
 * play.
 */
export interface CompatibilityAudioSpec {
  /** Stream to derive the new track from. */
  sourceStreamIndex: number
  channels: number
  language: string
  bitrateKbps: number
}

/**
 * One audio track to re-encode in place of itself.
 *
 * Distinct from `CompatibilityAudioSpec`, which *adds* a track: this one
 * replaces, so it carries no language — the track keeps whatever it had, being
 * the same track. Only the named tracks are encoded; everything else in the
 * file, the video above all, is still copied.
 */
/**
 * Converting a Dolby Vision profile 7 stream to profile 8.1.
 *
 * Profile 7 is what a UHD Blu-ray carries: a base layer, an enhancement layer
 * and an RPU. Profile 8.1 is the single-layer form whose base layer *is*
 * HDR10, so a client that cannot decode Dolby Vision gets a correct picture
 * instead of nothing. The conversion discards the enhancement layer, which is
 * a real loss on a full-enhancement-layer disc and no loss at all on a
 * minimum-enhancement-layer one — and the base layer, the picture itself, is
 * copied through untouched either way.
 */
export interface DolbyVision7Spec {
  /** The video track to convert, by its index in the source file. */
  sourceStreamIndex: number
  /**
   * Frames per second, carried from the probe.
   *
   * The converted stream comes back as raw HEVC, which holds no timing of its
   * own. Muxing it without saying the rate makes ffmpeg assume 25, and a
   * 23.976 film then runs fast and drifts out of step with its own audio.
   */
  frameRate?: number
}

export interface AudioReplacementSpec {
  /** The track to encode, by its index in the source file. */
  sourceStreamIndex: number
  channels: number
  bitrateKbps: number
}

/** Everything the command builder needs for a video re-encode. */
export interface VideoTranscodeSpec {
  sourceStreamIndex: number
  codec: 'h264' | 'hevc'
  /** Apply a deinterlacing filter before encoding. */
  deinterlace: boolean
  /** Downscale to this height when set. */
  scaleHeight?: number
  /** Force 8-bit 4:2:0 output (needed for High 10 and 4:2:2/4:4:4 sources). */
  forceYuv420p: boolean
  /**
   * Apply the Dolby Vision RPU and write plain BT.2020 PQ HDR10.
   *
   * Only ever set for profile 5, and only when the active ffmpeg has a working
   * libplacebo. The Dolby Vision layer is deliberately gone from the output:
   * the alternative is a file whose colours are wrong on everything that
   * cannot decode DV.
   */
  dolbyVisionToHdr10?: boolean
  /** Constant-quality target. */
  quality: number
}

export interface RepairPlan {
  strategy: PlanStrategy
  /** Target container extension for the output, e.g. "mp4" or "mkv". */
  targetContainer: 'mp4' | 'mkv'
  actions: PlanAction[]
  trackChanges: TrackPlanChange[]
  /**
   * Subtitle streams to measure against the audio and retime, in the same pass.
   *
   * Measuring is the expensive half — silence detection reads the whole audio
   * track — so this is only ever populated when the setting asking for it is
   * on, or when a rule asked for these tracks by name.
   */
  resyncSubtitles: number[]
  /** Set when a companion AAC track should be added. */
  addCompatibilityAudio?: CompatibilityAudioSpec
  /**
   * Audio tracks to re-encode in place of themselves.
   *
   * Empty or absent on almost every plan. When it is set, the video is still
   * copied: this is the cheap kind of encode, and the list says exactly which
   * tracks pay for it.
   */
  replaceAudio?: AudioReplacementSpec[]
  /** Set when the video stream must be re-encoded. */
  videoTranscode?: VideoTranscodeSpec
  /**
   * Set when a Dolby Vision profile 7 stream should be converted to 8.1.
   *
   * Not a transcode, which is why it is not one of the fields above: the
   * picture is copied untouched and only the Dolby Vision metadata changes.
   * The work happens before ffmpeg is asked to write anything — the video
   * stream goes through `dovi_tool` and comes back as a file the mux reads in
   * place of the original track.
   */
  dolbyVision7To81?: DolbyVision7Spec
  /** Write the MP4 index to the front of the file. */
  faststart: boolean
  /** Retag the video stream (e.g. HEVC as `hvc1` for Apple clients). */
  videoCodecTag?: string
  /**
   * Relabel the H.264 level (e.g. 41) without re-encoding, when the stream's
   * label is too high but its demands fit. Only set when the video is copied.
   */
  videoLevel?: number
  /**
   * File-level tags to write, by the names ffmpeg knows.
   *
   * Only ever set by hand, like `setTitle`, and only from a closed list of
   * keys — nothing reaches ffmpeg's argument list that was not on it.
   */
  metadataTags?: Record<string, string>
  /** Findings this plan does not address. */
  unresolved: Finding[]
  /** True when a safe (lossless) plan cannot fix every blocker. */
  requiresTranscode: boolean
  /** Rough note about cost, e.g. "stream copy" / "GPU video re-encode". */
  costNote: string
}

export type FileVerdict =
  /** Direct plays on essentially every Plex client. */
  | 'ok'
  /** Works, but some clients will transcode or mis-handle something. */
  | 'warn'
  /** Will force a transcode or fail for most remote clients. */
  | 'fail'
  /** ffprobe could not read the file. */
  | 'error'

export interface AnalysisResult {
  file: MediaFile
  verdict: FileVerdict
  findings: Finding[]
  plan: RepairPlan
  /** The language chosen as the file's primary/original language. */
  primaryLanguage: string
  /** How `primaryLanguage` was determined, for display. */
  primaryLanguageSource: 'video-stream-tag' | 'preferred-setting' | 'majority-audio' | 'first-audio' | 'fallback'
  /** When the file was probed (ms since epoch); set by the scanner, not by analysis. */
  scannedAt?: number
  /** The folder this file was found under, for mirroring into an output directory. */
  scanRoot?: string
}

export interface ScanError {
  path: string
  message: string
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/** What a repair is allowed to do: per file, per folder, or globally. */
export type RepairMode =
  /** Analyse only; never write. */
  | 'report'
  /** Analyse and apply lossless fixes; flag anything needing a transcode. */
  | 'safe-remux'
  /** Apply lossless fixes and re-encode whatever a safe remux cannot fix. */
  | 'force-transcode'

export type OutputPlacement =
  /** Write `name.plexfixed.ext` beside the original. */
  | 'sibling'
  /** Replace the original (original moved aside first when backups are on). */
  | 'in-place'
  /** Write into a user-chosen output directory, mirroring the input tree. */
  | 'output-dir'

/**
 * Where one run's repaired files go, when that is not what Settings says.
 *
 * Settings holds the standing answer; this is the answer for the repair about
 * to be queued and nothing else. A re-encode is the slow, lossy, hard-to-undo
 * repair, and "write it somewhere else this once" — a scratch disk with room,
 * a folder to check the result in before it goes near the library — is a
 * decision made at the moment of starting it, not months earlier in Settings.
 */
export interface OutputOverride {
  placement: OutputPlacement
  /** Required by `output-dir`, and ignored by the other two. */
  directory?: string
}

export interface AppSettings {
  /** Mode for files with no override of their own, and no overridden folder above them. */
  defaultMode: RepairMode

  /** Preferred language for the default audio track (ISO 639-2/B). */
  preferredAudioLanguage: string
  /** Preferred language for subtitles. */
  preferredSubtitleLanguage: string
  /** Fallback audio languages, in priority order, when the preferred one is absent. */
  fallbackAudioLanguages: string[]
  /** Write this language onto any track tagged `und`. */
  assumeUndefinedIs: string
  /** Mark a forced subtitle in the preferred language as default. */
  preferForcedSubtitles: boolean
  /** Set a full subtitle track as default when no audio matches the preferred language. */
  defaultSubtitleWhenForeignAudio: boolean
  /** Never set commentary / SDH tracks as default. */
  avoidCommentaryAsDefault: boolean

  /** Target container for remuxes. */
  targetContainer: 'mp4' | 'mkv'
  /** Convert MKV to MP4 where the streams allow it. */
  remuxMkvToMp4: boolean
  /**
   * Measure every text subtitle against the audio during a repair and correct
   * what is out of step.
   *
   * Off by default, because it is the one thing in a repair whose cost is not
   * proportional to the file: silence detection reads the audio from end to
   * end, which is twenty seconds to a minute on a feature film, whether or not
   * anything turns out to be wrong.
   */
  resyncSubtitlesOnRepair: boolean
  /** Drop image-based (PGS/VobSub) subtitles when remuxing to MP4. */
  dropImageSubtitlesOnMp4: boolean
  /**
   * What to do with a file whose every audio track needs converting.
   *
   * `add` keeps the originals and puts one AAC track beside them, which is the
   * right answer for a disc rip: the lossless track is the reason the file is
   * forty gigabytes, and throwing it away to fix a compatibility problem is a
   * poor trade. `replace` re-encodes the offending tracks in place of
   * themselves, for somebody who wants one audio track and wants it to play.
   * `off` leaves the file alone and says so — the findings stay on the report
   * as unresolved, because they are.
   */
  compatibilityAudio: 'add' | 'replace' | 'off'
  /** Treat HEVC as compatible (modern client fleet only). */
  allowHevc: boolean
  /** Highest H.264 level to accept without flagging, e.g. 41 for Level 4.1. */
  maxH264Level: number
  /** Flag resolutions above this height. */
  maxHeight: number

  /** Where repaired files are written. */
  outputPlacement: OutputPlacement
  outputDirectory: string
  /** Keep the original file alongside/aside when writing in place. */
  keepBackups: boolean
  /** Days a backup is kept before it is removed automatically; 0 keeps it until removed by hand. */
  backupRetentionDays: number
  /** Suffix used for sibling output. */
  outputSuffix: string
  /**
   * Patterns for naming repaired files, in `{field}` tokens.
   *
   * Two of them, because the two kinds of file are named differently and
   * always have been: a film is its title and its year, an episode is its
   * series, its numbers and then its own name. One pattern covering both
   * would decline to use itself on half a library.
   *
   * Empty, the default, means a repaired file keeps the name its source had.
   * See src/shared/plex/naming.ts for what a token may be and for what
   * happens when one of them has nothing behind it.
   */
  /**
   * Which extension an MP4 is written with.
   *
   * `.m4v` is an MP4 — Apple's name for one with video in it, and what an
   * iTunes library is full of. `keep` leaves a file that is already one of
   * the two alone, which is the only answer that never renames anything.
   */
  mp4Extension: 'keep' | 'mp4' | 'm4v'
  movieTemplate: string
  episodeTemplate: string

  /** Hardware encoder preference for forced transcodes. */
  hardwareEncoder: 'auto' | 'nvenc' | 'videotoolbox' | 'qsv' | 'amf' | 'none'
  /** Constant-quality target for video re-encodes (lower = better). */
  videoQuality: number
  /** Codec to use when re-encoding video. */
  transcodeVideoCodec: 'h264' | 'hevc'
  /** Bitrate per channel for AAC re-encodes, in kbps. */
  aacBitratePerChannel: number
  /** How many files to process at once. */
  concurrency: number

  /** Override for the bundled ffmpeg binaries. */
  ffmpegPath: string
  ffprobePath: string

  /**
   * Run ffprobe and ffmpeg on the machine that holds the files, over SSH.
   *
   * A remux copies every byte; across a mounted share that is two network
   * trips per byte. Running it where the disk is makes it one local copy.
   */
  remoteEnabled: boolean
  /** `user@host`, or a Host alias from the user's ssh config. */
  remoteHost: string
  /** 0 means whatever ssh would use by itself. */
  remotePort: number
  /**
   * Private key to authenticate with; blank uses whatever ssh would (your
   * agent, then the default identities).
   */
  remoteKeyPath: string
  /** Remote binaries; blank means look on the remote PATH. */
  remoteFfmpegPath: string
  remoteFfprobePath: string
  /**
   * Where the remote browser opens.
   *
   * Blank means the account's home directory. A library is rarely there — it
   * is usually several levels down a mount point — so walking to it from home
   * every time is most of the browsing.
   */
  remoteDefaultPath: string

  /**
   * What to do with Dolby Vision profile 5, which has no HDR10 base layer.
   *
   * `keep` leaves it alone and reports it, which is what every earlier version
   * did. `hdr10` re-encodes it to plain HDR10 through libplacebo: the picture
   * is rebuilt, the Dolby Vision layer is dropped on purpose, and the colours
   * come out right on every client instead of only on DV-capable ones.
   */
  dolbyVision5: 'keep' | 'hdr10'
  /**
   * What to do with Dolby Vision profile 7, the dual-layer form.
   *
   * `profile8` converts to 8.1: the enhancement layer is discarded and the RPU
   * rewritten, which is a stream rewrite rather than a re-encode — the picture
   * is not touched and the result is the same HEVC base layer with metadata
   * every client understands. It needs `dovi_tool`, which ffmpeg cannot
   * replace. `keep` reports the file and leaves it alone.
   */
  dolbyVision7: 'keep' | 'profile8'

  /**
   * A key of your own for themoviedb.org, used to look a film up.
   *
   * Yours rather than one shipped with the app: TMDB gives one away for the
   * asking and asks that it not be passed around, which rules out putting one
   * in a binary anybody can open. Empty until you paste one in, and the lookup
   * simply says so until then.
   */
  tmdbCredential: string

  /* ---------------------------------------------------------------- *
   * Subtitles
   * ---------------------------------------------------------------- */

  /**
   * Which service to look for subtitles on, by provider id.
   *
   * One of them at the moment; an id rather than a boolean so that the second
   * one does not need a settings migration.
   */
  subtitleProvider: string
  /**
   * An OpenSubtitles API key of your own, for the same reason TMDB needs one:
   * they give one away for the asking and ask that it not be passed around,
   * which rules out shipping one inside a binary anybody can open.
   */
  openSubtitlesKey: string
  /**
   * The account a download is counted against.
   *
   * Searching needs only the key. Downloading spends one of a daily allowance
   * that belongs to an account, so it needs the account.
   *
   * The password is kept in `settings.json` in the clear, like every other
   * credential here. That is worth knowing before typing one in: this app has
   * no keychain integration, and a file in the application support directory
   * is readable by anything running as you. It is an account for downloading
   * subtitles, which is about the lowest-value password there is, and it is
   * still a password — if that is not a trade worth making, leave it empty and
   * the rest of the subtitle features work without it.
   */
  openSubtitlesUsername: string
  openSubtitlesPassword: string
  /**
   * Which languages to look for, over and above the preferred subtitle
   * language. Empty means just that one.
   */
  subtitleSearchLanguages: string[]
  /** Leave a subtitle alone if it is already within this many milliseconds. */
  subtitleSyncToleranceMs: number

  /** Where a transcription is done. */
  transcriptionEngine: 'whisper-local' | 'groq' | 'openai'
  /** The `whisper-cli` binary, for a transcription done on this machine. */
  whisperPath: string
  /** The model file it loads — a `ggml-*.bin`. */
  whisperModelPath: string
  /** Threads for a local run; 0 lets Whisper decide. */
  whisperThreads: number
  /**
   * The speech endpoint, when the transcription is not local.
   *
   * Read by the native side to decide what it may fetch, so an address typed
   * here is an address this app will talk to. Blank uses whatever the chosen
   * service's own default is.
   */
  subtitleTranscriptionEndpoint: string
  subtitleTranscriptionCredential: string
  subtitleTranscriptionModel: string
  /** How much audio goes in one upload, in minutes. */
  transcriptionChunkMinutes: number

  /** Which shape of model endpoint a translation talks to. */
  translationEngine: 'ollama' | 'openai' | 'anthropic'
  /** Same as above: named here, and therefore fetchable. */
  subtitleTranslationEndpoint: string
  subtitleTranslationCredential: string
  subtitleTranslationModel: string
  /** How many lines go to the model at once. */
  translationBatchSize: number

  /** Extensions treated as media when walking folders. */
  mediaExtensions: string[]
  /** Recurse into subfolders when a folder is scanned. */
  recursive: boolean

  /**
   * Check and repair modules the user has switched off, by id.
   *
   * A list of what is *off* rather than what is on, so a module added in a
   * later version arrives switched on. The opposite — storing what is enabled —
   * would silently leave every new rule out for anyone who had ever opened
   * this screen.
   */
  disabledModules: string[]
  /**
   * Modules that ship switched off, and that you have switched on.
   *
   * The mirror of `disabledModules`, and a separate list because an id that
   * is absent from one list has to be able to mean "on" in one case and
   * "off" in the other.
   */
  enabledModules: string[]

  /**
   * Rules the user wrote, as the text they typed.
   *
   * Only the script is kept: the name, the explanations and everything else
   * are read back out of it, so there is one copy of each and no way for the
   * two to disagree. A script that no longer parses keeps its place in the
   * list and is shown as broken rather than being dropped.
   */
  userModules: { id: string; script: string }[]
}

/**
 * Mode overrides keyed by absolute path.
 *
 * A key may be a file or a folder; `resolveMode` in `shared/mode.ts` picks the
 * most specific one that covers a given file.
 */
export type ModeOverrides = Record<string, RepairMode>

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'

export interface JobProgress {
  /** 0..1 */
  fraction: number
  /** Output position in seconds, parsed from ffmpeg progress. */
  outTimeSeconds?: number
  speed?: string
  fps?: number
  /** Bytes written so far; the only progress signal on some sources. */
  bytesWritten?: number
}

export type JobLogLevel = 'info' | 'warn' | 'error'

export interface JobLogEntry {
  /** Epoch milliseconds, so the UI can show elapsed time per step. */
  at: number
  level: JobLogLevel
  /** One step, e.g. "Promoted output" or "ffmpeg exited with code 1". */
  text: string
  /** Multi-line payload shown indented under the step (a command, stderr). */
  detail?: string
}

/* ------------------------------------------------------------------ *
 * Repair performance
 * ------------------------------------------------------------------ */

/** The measurable stages of a repair. */
export type JobPhase =
  /** Deciding whether the repair fits in the file's header. */
  | 'in-place-check'
  /** Writing those header fields. */
  | 'in-place-edit'
  /** ffmpeg, start to exit. */
  | 'ffmpeg'
  /** qt-faststart moving the MP4 index, when that is the whole repair. */
  | 'qt-faststart'
  /** The tail of the ffmpeg run after the last progress report — the MP4 index move. */
  | 'finalise'
  /** Re-probing the output to confirm it is what was asked for. */
  | 'verify'
  /** Backing up the original and moving the output into place. */
  | 'promote'
  /** Measuring subtitle timing against the audio and correcting it. */
  | 'subtitles'
  /** Rewriting a Dolby Vision profile 7 stream as single-layer 8.1. */
  | 'dolby-vision'
  /** Queued to finished. */
  | 'total'

export interface JobPhaseTiming {
  phase: JobPhase
  ms: number
  /** Bytes the phase moved, where it moved any. */
  bytes?: number
  /** Why it took the path it did, when that is the interesting part. */
  note?: string
}

/** Whether a path is on a local disk or across a network, and where. */
export interface VolumeInfo {
  /** Mount point, e.g. `/` or `/Volumes/Media`. */
  mount?: string
  /** What is mounted there: a device node, or `//user@host/share` for SMB. */
  filesystem?: string
  kind: 'local' | 'network' | 'unknown'
  /** Device id from stat(2); equal ids mean a move is a rename, not a copy. */
  device?: number
  /** Filesystem type on macOS, e.g. `apfs`, `hfs`, `exfat`, `smbfs`. */
  type?: string
}

/**
 * What a repair actually cost, measured rather than guessed.
 *
 * A remux is a byte copy, so "slower than expected" is nearly always one of
 * four things: the source is read over a network, the MP4 index move is a
 * second pass over the file, the finished file lands on a different volume and
 * has to be copied there, or the disk is simply slow. Timing each stage
 * separately is what tells those apart.
 */
export interface JobMetrics {
  sourceBytes?: number
  outputBytes?: number
  /** Running time of the media, for the realtime multiple. */
  durationSeconds?: number
  phases: JobPhaseTiming[]
  /** Output bytes over the ffmpeg phase, in MB/s. */
  mbPerSecond?: number
  /** ffmpeg's own speed figure at the end, e.g. `12.4x`. */
  ffmpegSpeed?: string
  source?: VolumeInfo
  output?: VolumeInfo
  /** False when the output had to cross volumes to reach its destination. */
  sameVolume?: boolean
}

/**
 * Where a repair has got to, as a step rather than a percentage.
 *
 * A percentage only exists while ffmpeg is copying. Everything either side of
 * that — connecting, re-probing the output, moving the file into place — can
 * take minutes on a big file or a slow link, and without a step to show, the
 * bar sits at 100% and the repair looks hung when it is working.
 */
export type JobStage =
  | 'waiting'
  /** Reaching the machine that holds the file, and looking at where it lives. */
  | 'connecting'
  /** Working out what to run. */
  | 'planning'
  /** ffmpeg, copying. */
  | 'copying'
  /** The second pass that moves an MP4 index to the front. */
  | 'finalising'
  /** Re-probing the output to confirm it is what was asked for. */
  | 'verifying'
  /** Backing up the original and moving the output into place. */
  | 'promoting'
  /** Measuring subtitle timing against the audio and correcting it. */
  | 'subtitles'
  /** Rewriting a Dolby Vision profile 7 stream as single-layer 8.1. */
  | 'dolby-vision'
  | 'finished'

/**
 * What a finished job actually did, as against what state it ended in.
 *
 * `state` answers "did it work", which is the wrong question for a run of
 * forty files: a hundred rows all saying `skipped` cover a file that was
 * already perfect, a file nothing can fix, and a file whose repair this mode
 * declines to run — three different things, needing three different answers
 * from the person reading. The message said which, in prose, one row at a
 * time. This says it in a form that can be counted.
 */
export type JobOutcome =
  /** Something in the file changed. */
  | 'repaired'
  /** Only the name changed; not a byte of the file was copied. */
  | 'renamed'
  /** Nothing to do, and nothing wrong — the file was already right. */
  | 'already-right'
  /** Something is wrong and no repair this app has addresses it. */
  | 'blocked'
  /** A repair exists, but this file's mode will not run it. */
  | 'needs-transcode'
  /** The mode forbade writing anything. */
  | 'report-only'

/** The machine a job is running on, recorded when it starts. */
export interface JobHost {
  kind: 'local' | 'remote'
  /** `this machine`, or `plex@nas`. */
  label: string
}

export interface Job {
  id: string
  sourcePath: string
  /** What it did, once it has finished doing it. */
  outcome?: JobOutcome
  outputPath: string
  strategy: PlanStrategy
  mode: RepairMode
  state: JobState
  progress: JobProgress
  /** Final ffmpeg command, for transparency / copy-paste. */
  command?: string[]
  message?: string
  startedAt?: number
  finishedAt?: number
  /** Ordered record of what the repair actually did, for sharing in a report. */
  log: JobLogEntry[]
  /** What each stage of the repair cost; filled in as the job runs. */
  metrics?: JobMetrics
  /** Where it has got to. */
  stage?: JobStage
  /** The machine it is running on. */
  host?: JobHost
  /**
   * When this job last reported anything at all.
   *
   * A remote repair can stop reporting because the link went quiet rather than
   * because it failed; this is what lets the queue say "no update for 40s"
   * instead of showing a bar that has silently stopped moving.
   */
  updatedAt?: number
}

/* ------------------------------------------------------------------ *
 * IPC payloads
 * ------------------------------------------------------------------ */

export interface ScanRequest {
  paths: string[]
  mode?: RepairMode
}

export interface ScanProgressEvent {
  scanId: string
  processed: number
  total: number
  currentPath?: string
  /**
   * The analysis of `currentPath`, when it probed cleanly. Results stream in
   * here, one per file, so the table fills and the library is saved as the scan
   * goes rather than all at the end; failures arrive in `ScanCompleteEvent`.
   */
  result?: AnalysisResult
}

/** Re-analysis of one file, for the per-row refresh button. */
export interface RescanResult {
  /** The analysis, when the file could be read. */
  result?: AnalysisResult
  /** Set when the file is gone — e.g. an in-place repair renamed it. */
  missing?: boolean
  /** Set when the file is present but could not be probed. */
  error?: string
}

export interface ScanCompleteEvent {
  scanId: string
  /** The paths the scan was started with. */
  inputPaths: string[]
  errors: ScanError[]
  /** Every media file the walk found, probed or not. */
  foundPaths: string[]
  /** True when the scan was cancelled part-way: files not reached say nothing. */
  cancelled: boolean
  /** Leftover repair temporary files the scan found and removed. */
  cleaned?: { path: string; bytes: number }[]
}

/**
 * A file the renderer wants repaired. The library holds the scan, which may be
 * from an earlier session; the main process uses it only if the file on disk
 * still matches, and re-probes otherwise.
 */
/** What a person can change about one track, on the metadata screen. */
export interface TrackEdit {
  /** The track's name, as a player shows it. */
  title?: string
  /** ISO 639-2 code. */
  language?: string
  /** Plays, or appears, without being chosen. */
  default?: boolean
  /** Shown automatically for foreign dialogue. */
  forced?: boolean
}

/**
 * Metadata asked for by hand.
 *
 * The one instruction this app takes rather than works out. The rules that
 * apply it, and the list of file tags that may be written, are in
 * `plex/metadata.ts`; only the shape is here, with the other domain types.
 */
export interface MetadataEdit {
  /** File-level tags, by the names ffmpeg knows. */
  tags?: Record<string, string>
  /** Per-track changes, by stream index. */
  tracks?: Record<number, TrackEdit>
}

export interface RepairRequest {
  file: MediaFile
  scanRoot?: string
  /**
   * Metadata asked for by hand, when this came from the metadata screen.
   *
   * Carried with the request rather than stored anywhere: an edit is made,
   * previewed and applied in one go, so there is no pending state to go stale
   * against a file that changed underneath it.
   */
  edits?: MetadataEdit
}

/** What the main process found when it looked for the ffmpeg toolchain. */
export interface EnvironmentInfo {
  ffmpegPath?: string
  ffprobePath?: string
  /** Moves an MP4's index in one pass; optional, ffmpeg does it otherwise. */
  qtFaststartPath?: string
  /**
   * Writes a file's own tags without rewriting it; optional.
   *
   * Without it a tag edit goes through ffmpeg, which copies every byte of the
   * film to change two words.
   */
  mp4tagsPath?: string
  /**
   * Converts a Dolby Vision profile 7 stream to 8.1; optional.
   *
   * Nothing in ffmpeg writes a Dolby Vision RPU, so without this the app can
   * report a profile 7 file and nothing more.
   */
  doviToolPath?: string
  ffmpegSource?: 'settings' | 'bundled' | 'path'
  ffprobeSource?: 'settings' | 'bundled' | 'path'
  ffmpegVersion?: string
  ready: boolean
  /** Why the toolchain is unusable, when `ready` is false. */
  problem?: string
  /** What to do about `problem`, when there is something to do. */
  hint?: string
  capabilities?: EncoderCapabilities
  /** Set when scans and repairs run on another machine over SSH. */
  remote?: { host: string; platform?: string }
}

/** What the About panel reports: the build, and the runtime under it. */
export interface AboutInfo {
  version: string
  /** False in a dev run, where the version is the working tree's, not a build's. */
  packaged: boolean
  /** The Tauri version the app is built on. */
  tauri: string
  /** The system webview rendering it: WKWebView on macOS, WebView2 on Windows. */
  webview: string
  /** Node's name for the platform — `darwin`, `win32`, `linux`. */
  platform: string
  arch: string
  /** The OS version: macOS `15.1`, Windows `10.0.22631`. */
  systemVersion: string
  /** The folder holding `settings.json` and the repair-mode overrides. */
  userDataPath: string
}

/** What a connection test found on the machine that holds the files. */
export interface RemoteCheck {
  ok: boolean
  host: string
  /** `Linux x86_64`, when it answered. */
  platform?: string
  ffmpegPath?: string
  ffmpegVersion?: string
  ffprobePath?: string
  ffprobeVersion?: string
  /** Optional: when present, index-only repairs use it instead of a remux. */
  qtFaststartPath?: string
  /** POSIX utilities the scan and repair need that are not there. */
  missing: string[]
  /** The ones that are, so a passing check still shows its working. */
  found: string[]
  /** Why the check failed. */
  problem?: string
  /** What to do about it, when there is something to do. */
  hint?: string
  /**
   * The host is reachable but its key is not in `known_hosts` yet. The
   * fingerprints below are what it offered; trusting it writes them there.
   */
  hostKeyUnknown?: boolean
  /**
   * There *is* an entry for this host and it no longer matches. Never
   * offered as something to accept: this is either a rebuilt machine or
   * someone else answering at that address, and only the user knows which.
   */
  hostKeyChanged?: boolean
  fingerprints?: HostKeyFingerprint[]
}

export interface HostKeyFingerprint {
  /** `ssh-ed25519`, `ssh-rsa`… */
  type: string
  /** `SHA256:…`, as `ssh-keygen -l` prints it. */
  fingerprint: string
}

/** One entry in the remote file browser. */
export interface RemoteEntry {
  name: string
  path: string
  isDirectory: boolean
  sizeBytes?: number
  /** True for a file PlexFixer would scan. */
  isMedia?: boolean
}

export interface RemoteListing {
  /** The directory that was listed, absolute. */
  path: string
  /** The parent, or undefined at the root. */
  parent?: string
  entries: RemoteEntry[]
  problem?: string
}

export interface EncoderCapabilities {
  /** Node's name for it — `darwin`, `win32`, `linux` — whichever machine it is. */
  platform: string
  /** Encoder names ffmpeg reports as available, e.g. `h264_nvenc`. */
  available: string[]
  nvenc: boolean
  videotoolbox: boolean
  qsv: boolean
  amf: boolean
  /**
   * The `libplacebo` filter, proven by running it rather than by being listed.
   *
   * It is the only thing in ffmpeg that can apply a Dolby Vision RPU, which is
   * what converting profile 5 to HDR10 needs. It also needs a Vulkan device,
   * so a build that has the filter on a machine with no Vulkan driver still
   * cannot use it — which is why this is a test run, not a list lookup.
   */
  libplacebo: boolean
  ffmpegVersion?: string
}
