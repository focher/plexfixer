/**
 * A fake machine, so the interface can be looked at without one.
 *
 * PlexFixer's UI only exists inside a Tauri window: everything it draws comes
 * from `window.plexfixer`, and in an ordinary browser that object is not there,
 * so the first thing `App` does — ask for the settings — throws before anything
 * renders. That makes the interface unreviewable except by building an
 * installer, installing it, and finding a film to point it at.
 *
 * This stands in for the machine. It answers every call the UI makes at render
 * time with plausible, fixed data — a small library with one clean file, one
 * that needs work and one that cannot be read — so `npm run renderer:dev`
 * shows the real components, with the real stylesheet, in a browser.
 *
 * **It is for looking at, not for using.** Nothing here touches a file, runs
 * ffmpeg or remembers anything past a reload. Anything that would do real work
 * resolves to a believable answer and says so in the console. It is installed
 * only when the page is not running under Tauri, so a real build never sees it.
 *
 * The cast at the bottom is deliberate. The API surface is some hundred
 * methods and a review harness needs perhaps thirty of them; writing the rest
 * as stubs to satisfy the type would be more code than the thing being
 * reviewed, and every one of them would be a lie of the same kind. What is
 * missing throws a clear error when something reaches for it, which is the
 * honest failure for a harness.
 */

import { analyzeFile } from '@shared/plex/analyze.js'
import { isImageSubtitle } from '@shared/plex/rules.js'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import type {
  AboutInfo,
  Job,
  AnalysisResult,
  AppSettings,
  EnvironmentInfo,
  MediaFile,
  MediaStream,
  StreamDisposition
} from '@shared/types.js'
import type { PlexFixerApi } from './tauri.js'

const NO_FLAGS: StreamDisposition = {
  default: false,
  forced: false,
  hearingImpaired: false,
  visualImpaired: false,
  commentary: false,
  dub: false,
  original: false,
  attachedPic: false
}

const flags = (overrides: Partial<StreamDisposition> = {}): StreamDisposition => ({ ...NO_FLAGS, ...overrides })

function video(overrides: Partial<Extract<MediaStream, { kind: 'video' }>> = {}): MediaStream {
  return {
    index: 0,
    kind: 'video',
    codec: 'h264',
    language: 'und',
    disposition: flags({ default: true }),
    tags: {},
    width: 1920,
    height: 1080,
    profile: 'High',
    level: 40,
    pixFmt: 'yuv420p',
    frameRate: 23.976,
    ...overrides
  } as MediaStream
}

function audio(overrides: Partial<Extract<MediaStream, { kind: 'audio' }>> = {}): MediaStream {
  return {
    index: 1,
    kind: 'audio',
    codec: 'aac',
    language: 'eng',
    disposition: flags({ default: true }),
    tags: {},
    channels: 2,
    channelLayout: 'stereo',
    sampleRate: 48_000,
    ...overrides
  } as MediaStream
}

function subtitle(overrides: Partial<Extract<MediaStream, { kind: 'subtitle' }>> = {}): MediaStream {
  const codec = overrides.codec ?? 'subrip'
  return {
    index: 2,
    kind: 'subtitle',
    codec,
    language: 'eng',
    disposition: flags(),
    tags: {},
    // The prober derives this from the codec, and so must this: a PGS track
    // that does not say it is picture-based is a fixture that tests the wrong
    // thing, and the panel would offer to retime a picture.
    isImageBased: isImageSubtitle(codec),
    ...overrides
  } as MediaStream
}

function file(path: string, streams: MediaStream[], overrides: Partial<MediaFile> = {}): MediaFile {
  const fileName = path.split('/').pop() ?? path
  return {
    path,
    fileName,
    extension: fileName.split('.').pop() ?? 'mkv',
    sizeBytes: 8_000_000_000,
    container: 'matroska',
    formatName: 'matroska,webm',
    durationSeconds: 7200,
    bitRate: 8_800_000,
    streams,
    tags: {},
    ...overrides
  }
}

/**
 * A library with one of each kind of problem, because a screen full of green
 * rows shows none of the interface worth reviewing.
 */
function library(settings: AppSettings): AnalysisResult[] {
  const root = '/library/Movies'

  const clean = file(
    `${root}/Arrival (2016)/Arrival (2016).mp4`,
    [video({ codec: 'h264' }), audio({ codec: 'aac', channels: 2 })],
    {
      extension: 'mp4',
      container: 'mp4',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      faststart: true,
      sizeBytes: 4_200_000_000
    }
  )

  const anime = file(
    `${root}/Ghost in the Shell (1995)/Ghost in the Shell (1995).mkv`,
    [
      video({ codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le', level: 51 }),
      audio({ codec: 'flac', language: 'jpn', channels: 6, channelLayout: '5.1' }),
      subtitle({ index: 2, codec: 'ass', language: 'eng', disposition: flags({ default: true }) }),
      subtitle({ index: 3, codec: 'ass', language: 'eng', title: 'Signs & Songs', disposition: flags({ forced: true }) })
    ],
    { sizeBytes: 12_400_000_000 }
  )

  const bluray = file(
    `${root}/Heat (1995)/Heat (1995).mkv`,
    [
      video({ codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le' }),
      audio({ codec: 'dts', language: 'eng', channels: 6, channelLayout: '5.1' }),
      audio({ index: 2, codec: 'ac3', language: 'fre', channels: 6, channelLayout: '5.1', disposition: flags() }),
      subtitle({ index: 3, codec: 'hdmv_pgs_subtitle', language: 'eng' }),
      subtitle({ index: 4, codec: 'subrip', language: 'fre' })
    ],
    { sizeBytes: 31_800_000_000, durationSeconds: 10_260 }
  )

  const interlaced = file(`${root}/Casablanca (1942)/Casablanca (1942).mkv`, [
    video({ codec: 'mpeg2video', width: 720, height: 576, profile: 'Main', level: 8 }),
    audio({ codec: 'mp3', language: 'eng', channels: 2 })
  ])

  // An episode, so the Type column and the SxEy code have something to show.
  // The season and episode come from the name, which is the commoner case: a
  // ripped file rarely carries show tags.
  const episode = file(
    `${root}/The Expanse/Season 2/The Expanse - S2E06 - Paradigm Shift.mkv`,
    [
      video({ codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le' }),
      audio({ codec: 'eac3', language: 'eng', channels: 6, channelLayout: '5.1' }),
      subtitle({ index: 2, codec: 'subrip', language: 'eng', disposition: flags({ default: true }) })
    ],
    { sizeBytes: 2_900_000_000, durationSeconds: 2_820, tags: { title: 'Paradigm Shift' } }
  )

  const tagged = file(
    `${root}/Severance/Season 1/Severance - S1E01.mkv`,
    [video({ codec: 'h264' }), audio({ codec: 'aac', language: 'eng', channels: 6, channelLayout: '5.1' })],
    {
      sizeBytes: 3_400_000_000,
      durationSeconds: 3_300,
      tags: { show: 'Severance', season_number: '1', episode_id: '1', title: 'Good News About Hell' }
    }
  )

  return [clean, anime, bluray, interlaced, episode, tagged].map((media) => ({
    ...analyzeFile(media, settings),
    scannedAt: Date.now(),
    scanRoot: root
  }))
}

/**
 * A queue with one of each state, because the Queue screen is mostly about
 * telling them apart: a running job with a bar, one waiting, one finished, one
 * that failed with a reason, and one skipped because nothing needed doing.
 */
function queue(): Job[] {
  const now = Date.now()
  const root = '/library/Movies'
  return [
    {
      id: 'preview-running',
      sourcePath: `${root}/Ghost in the Shell (1995)/Ghost in the Shell (1995).mkv`,
      outputPath: `${root}/Ghost in the Shell (1995)/Ghost in the Shell (1995).mp4`,
      strategy: 'transcode-video',
      mode: 'force-transcode',
      state: 'running',
      stage: 'copying',
      progress: { fraction: 0.42, speed: '3.1x', fps: 74, outTimeSeconds: 2_180 },
      startedAt: now - 7 * 60_000,
      updatedAt: now - 1_000,
      log: [{ at: now - 7 * 60_000, level: 'info', text: 'Re-encoding the video to HEVC' }]
    },
    {
      id: 'preview-queued',
      sourcePath: `${root}/Casablanca (1942)/Casablanca (1942).mkv`,
      outputPath: `${root}/Casablanca (1942)/Casablanca (1942).mp4`,
      strategy: 'transcode-video',
      mode: 'force-transcode',
      state: 'queued',
      progress: { fraction: 0 },
      log: []
    },
    {
      id: 'preview-done',
      sourcePath: `${root}/Arrival (2016)/Arrival (2016).mp4`,
      outputPath: `${root}/Arrival (2016)/Arrival (2016).mp4`,
      strategy: 'remux',
      mode: 'safe-remux',
      state: 'done',
      stage: 'finished',
      progress: { fraction: 1 },
      startedAt: now - 22 * 60_000,
      finishedAt: now - 21 * 60_000,
      message: 'Replaced the original (backed up first)',
      log: [{ at: now - 22 * 60_000, level: 'info', text: 'Tagged the video track as English' }]
    },
    {
      id: 'preview-failed',
      sourcePath: `${root}/Heat (1995)/Heat (1995).mkv`,
      outputPath: `${root}/Heat (1995)/Heat (1995).mp4`,
      strategy: 'transcode-audio',
      mode: 'safe-remux',
      state: 'failed',
      progress: { fraction: 0.08 },
      startedAt: now - 40 * 60_000,
      finishedAt: now - 39 * 60_000,
      message: 'No space left on the destination volume',
      log: [{ at: now - 39 * 60_000, level: 'error', text: 'ffmpeg exited 1: No space left on device' }]
    },
    {
      id: 'preview-skipped',
      sourcePath: `${root}/The Expanse/Season 2/The Expanse - S2E06 - Paradigm Shift.mkv`,
      outputPath: `${root}/The Expanse/Season 2/The Expanse - S2E06 - Paradigm Shift.mkv`,
      strategy: 'none',
      mode: 'safe-remux',
      state: 'skipped',
      progress: { fraction: 0 },
      finishedAt: now - 60 * 60_000,
      message: 'Needs a re-encode, and this run was a safe remux',
      log: []
    }
  ]
}

const ABOUT: AboutInfo = {
  version: '0.3.0',
  packaged: false,
  tauri: 'preview',
  webview: 'this browser',
  platform: 'darwin',
  arch: 'arm64',
  systemVersion: 'preview',
  userDataPath: '/preview/Application Support/PlexFixer'
}

const ENVIRONMENT: EnvironmentInfo = {
  ffmpegPath: '/preview/bin/ffmpeg',
  ffprobePath: '/preview/bin/ffprobe',
  ffmpegSource: 'bundled',
  ffprobeSource: 'bundled',
  ffmpegVersion: 'ffmpeg 7.1 (preview)',
  ready: true,
  capabilities: {
    platform: 'darwin',
    available: ['h264_videotoolbox', 'hevc_videotoolbox', 'libx264', 'libx265'],
    nvenc: false,
    videotoolbox: true,
    qsv: false,
    amf: false,
    libplacebo: true,
    ffmpegVersion: 'ffmpeg 7.1 (preview)'
  }
}

/** Nothing listens, so every subscription hands back a no-op. */
const never = (): (() => void) => () => undefined

export function installPreviewBridge(): void {
  // A key, so the metadata-lookup button renders in its live state rather
  // than greyed out. Nothing in the preview reaches themoviedb.org.
  let settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    tmdbCredential: 'preview',
    // Languages to translate into, so the per-track picker has something in it.
    // With the defaults it holds one entry — the track's own — which is what
    // made it look broken.
    subtitleSearchLanguages: ['fre', 'spa', 'deu']
  }
  let overrides: Record<string, string> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const progressListeners = new Set<(event: any) => void>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const completeListeners = new Set<(event: any) => void>()

  const api = {
    app: {
      about: async (): Promise<AboutInfo> => ABOUT,
      // The library loads itself, so the first screen has something on it
      // rather than the empty state nobody needs to review twice.
      initialPaths: async (): Promise<string[]> => ['/library/Movies'],
      saveText: async (name: string): Promise<string> => `/preview/${name}`,
      onShowAbout: never,
      onOpenPaths: never,
      onDragState: never,
      onDroppedPaths: never
    },
    settings: {
      get: async (): Promise<AppSettings> => settings,
      update: async (patch: Partial<AppSettings>): Promise<AppSettings> => {
        settings = { ...settings, ...patch }
        return settings
      },
      reset: async (): Promise<AppSettings> => {
        settings = { ...DEFAULT_SETTINGS }
        return settings
      }
    },
    overrides: {
      get: async (): Promise<Record<string, string>> => overrides,
      set: async (path: string, mode?: string): Promise<Record<string, string>> => {
        overrides = mode ? { ...overrides, [path]: mode } : Object.fromEntries(
          Object.entries(overrides).filter(([key]) => key !== path)
        )
        return overrides
      }
    },
    environment: {
      get: async (): Promise<EnvironmentInfo> => ENVIRONMENT,
      refresh: async (): Promise<EnvironmentInfo> => ENVIRONMENT
    },
    scan: {
      /**
       * Hand the fabricated library back the way a real scan does.
       *
       * Through the same two events, on a timer, so the progress line and the
       * rows arriving one at a time are the real behaviour rather than a
       * screen that is simply full from the start.
       */
      start: async (paths: string[], scanId: string): Promise<string> => {
        const found = library(settings)
        let processed = 0
        for (const result of found) {
          setTimeout(() => {
            processed++
            for (const listener of progressListeners) {
              listener({
                scanId,
                processed,
                total: found.length,
                currentPath: result.file.path,
                result
              })
            }
          }, processed * 120 + 120)
        }
        setTimeout(
          () => {
            for (const listener of completeListeners) {
              listener({
                scanId,
                inputPaths: paths,
                foundPaths: found.map((entry) => entry.file.path),
                errors: [],
                cleaned: [],
                cancelled: false
              })
            }
          },
          found.length * 120 + 240
        )
        return scanId
      },
      cancel: async (): Promise<void> => undefined,
      rescanFile: async (path: string) => library(settings).find((entry) => entry.file.path === path),
      onProgress: (listener: (event: unknown) => void) => {
        progressListeners.add(listener)
        return () => progressListeners.delete(listener)
      },
      onComplete: (listener: (event: unknown) => void) => {
        completeListeners.add(listener)
        return () => completeListeners.delete(listener)
      }
    },
    jobs: {
      enqueue: async (): Promise<void> => undefined,
      /** The sample queue arrives the way real ones do: one update per job. */
      onUpdate: (listener: (job: Job) => void) => {
        for (const job of queue()) setTimeout(() => listener(job), 60)
        return () => undefined
      },
      cancel: async (): Promise<void> => undefined,
      cancelAll: async (): Promise<string[]> => [],
      clearFinished: async (): Promise<void> => undefined,
      clearQueued: async (): Promise<void> => undefined
    },
    backups: {
      summary: async (): Promise<{ count: number; bytes: number }> => ({ count: 3, bytes: 24_000_000_000 }),
      removeAll: async (): Promise<{ removed: number }> => ({ removed: 3 })
    },
    dialog: {
      pickPaths: async (): Promise<string[]> => ['/library/Movies'],
      pickFolders: async (): Promise<string[]> => ['/library/Movies'],
      pickDirectory: async (): Promise<undefined> => undefined,
      pickBinary: async (): Promise<undefined> => undefined,
      pickSubtitle: async (): Promise<undefined> => undefined
    },
    shell: {
      reveal: async (): Promise<void> => undefined,
      fileMenu: async (): Promise<void> => undefined,
      openExternal: async (): Promise<void> => undefined
    },
    subtitles: {
      onProgress: never,
      cancel: (): void => undefined,
      whisper: {
        catalogue: [],
        directory: async (): Promise<string> => '/preview/models',
        installed: async (): Promise<[]> => [],
        onProgress: never,
        download: async (): Promise<{ cancelled: true }> => ({ cancelled: true }),
        cancel: async (): Promise<void> => undefined,
        remove: async (): Promise<void> => undefined,
        builds: async (): Promise<[]> => [],
        advice: async (): Promise<string> => 'This is the preview; nothing can be installed from it.',
        resolve: async (): Promise<{ source: 'none' }> => ({ source: 'none' }),
        builtins: async (): Promise<[]> => [],
        onInstallProgress: never,
        onInstallStage: never,
        install: async (): Promise<{ problem: string }> => ({ problem: 'Not in the preview.' }),
        cancelInstall: async (): Promise<void> => undefined,
        removeBuild: async (): Promise<void> => undefined
      }
    },
    /** The sample library, so a screen has something on it. */
    __preview: { library: () => library(settings) }
  }

  window.plexfixer = api as unknown as PlexFixerApi
}

/** The fabricated library, for the harness to load without a scan. */
export function previewLibrary(settings: AppSettings): AnalysisResult[] {
  return library(settings)
}
