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
  refFrames?: number
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
  /** Sidecar subtitle files found next to the media file. */
  sidecarSubtitles: string[]
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
  setDefault?: boolean
  setForced?: boolean
  /** Stream is dropped from the output entirely. */
  drop?: boolean
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
  /** Constant-quality target. */
  quality: number
}

export interface RepairPlan {
  strategy: PlanStrategy
  /** Target container extension for the output, e.g. "mp4" or "mkv". */
  targetContainer: 'mp4' | 'mkv'
  actions: PlanAction[]
  trackChanges: TrackPlanChange[]
  /** Subtitle streams to write out as sidecar .srt files. */
  extractSubtitles: { streamIndex: number; language: string; forced: boolean }[]
  /** Set when a companion AAC track should be added. */
  addCompatibilityAudio?: CompatibilityAudioSpec
  /** Set when the video stream must be re-encoded. */
  videoTranscode?: VideoTranscodeSpec
  /** Write the MP4 index to the front of the file. */
  faststart: boolean
  /** Retag the video stream (e.g. HEVC as `hvc1` for Apple clients). */
  videoCodecTag?: string
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

/** What a repair is allowed to do; chosen per repair. */
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

export interface AppSettings {
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
  /** Pull text subtitles out to sidecar .srt files. */
  extractTextSubtitles: boolean
  /** Drop image-based (PGS/VobSub) subtitles when remuxing to MP4. */
  dropImageSubtitlesOnMp4: boolean
  /** Always add a stereo AAC track when none exists. */
  ensureAacStereo: boolean
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
  /** Suffix used for sibling output. */
  outputSuffix: string

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

  /** Extensions treated as media when walking folders. */
  mediaExtensions: string[]
  /** Recurse into subfolders when a folder is scanned. */
  recursive: boolean
}

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

export interface Job {
  id: string
  sourcePath: string
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
}

/**
 * A file the renderer wants repaired. The library holds the scan, which may be
 * from an earlier session; the main process uses it only if the file on disk
 * still matches, and re-probes otherwise.
 */
export interface RepairRequest {
  file: MediaFile
  scanRoot?: string
}

/** What the main process found when it looked for the ffmpeg toolchain. */
export interface EnvironmentInfo {
  ffmpegPath?: string
  ffprobePath?: string
  ffmpegSource?: 'settings' | 'bundled' | 'path'
  ffprobeSource?: 'settings' | 'bundled' | 'path'
  ffmpegVersion?: string
  ready: boolean
  /** Why the toolchain is unusable, when `ready` is false. */
  problem?: string
  capabilities?: EncoderCapabilities
}

export interface EncoderCapabilities {
  platform: NodeJS.Platform
  /** Encoder names ffmpeg reports as available, e.g. `h264_nvenc`. */
  available: string[]
  nvenc: boolean
  videotoolbox: boolean
  qsv: boolean
  amf: boolean
  ffmpegVersion?: string
}
