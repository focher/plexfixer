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
  /**
   * Relabel the H.264 level (e.g. 41) without re-encoding, when the stream's
   * label is too high but its demands fit. Only set when the video is copied.
   */
  videoLevel?: number
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
  /** Days a backup is kept before it is removed automatically; 0 keeps it until removed by hand. */
  backupRetentionDays: number
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

  /** Extensions treated as media when walking folders. */
  mediaExtensions: string[]
  /** Recurse into subfolders when a folder is scanned. */
  recursive: boolean
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
  /** The tail of the ffmpeg run after the last progress report — the MP4 index move. */
  | 'finalise'
  /** Re-probing the output to confirm it is what was asked for. */
  | 'verify'
  /** Backing up the original and moving the output into place. */
  | 'promote'
  /** Writing subtitle sidecars. */
  | 'subtitles'
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
  /** Writing subtitle sidecars. */
  | 'subtitles'
  | 'finished'

/** The machine a job is running on, recorded when it starts. */
export interface JobHost {
  kind: 'local' | 'remote'
  /** `this machine`, or `plex@nas`. */
  label: string
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
