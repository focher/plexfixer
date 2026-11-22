/**
 * The Tauri backing for `window.plexfixer`.
 *
 * The UI knows one API, the one `src/preload/index.ts` has always exposed. On
 * Electron the preload script installs it; under Tauri there is no preload, so
 * this installs the same shape over `invoke` instead. Nothing in `App.tsx` or
 * the components can tell the difference, which is the whole point: the port
 * replaces the host, not the app.
 *
 * Two conventions here are worth knowing:
 *
 *   * Shapes stay in TypeScript. Rust returns the stored settings map as-is
 *     and `withDefaults` fills it in here, so adding a setting never means
 *     editing Rust. Same for the command line, which `parseLaunchArgs` reads.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { scriptInfo, type ScriptInfo, type ScriptListing } from '@shared/plex/scripts/manifest.js'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { withDefaults } from '@shared/defaults.js'
import { parseLaunchArgs } from '@shared/launch.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { ProbeError, probeFile } from '@shared/plex/probe.js'
import { DOLBY_VISION_HDR10_FILTER } from '@shared/plex/rules.js'
import { runScan, type KnownFile } from '@shared/plex/scan.js'
import { loadLibrary } from '../library.js'
import { RepairRunner } from '@shared/plex/runner.js'
import { createBackupRegistry, findBackups } from '@shared/plex/backups-store.js'
import { repairModeFor } from '@shared/mode.js'
import type { BackupRecord } from '@shared/backups.js'
import type {
  AboutInfo,
  AppSettings,
  EnvironmentInfo,
  HostKeyFingerprint,
  Job,
  ModeOverrides,
  RemoteCheck,
  RemoteListing,
  RepairMode,
  RepairRequest,
  RescanResult,
  ScanCompleteEvent,
  ScanProgressEvent
} from '@shared/types.js'
import { hostKeyTools, tauriHost } from './host.js'
import { remoteHost, remoteTargetFor } from '@shared/plex/remote-host.js'
import { checkRemote } from '@shared/plex/remote-check.js'
import { trustHost } from '@shared/plex/hostkey.js'
import { detectEncoders } from '@shared/plex/encoders.js'
import { startDirectory } from '@shared/remote-browse.js'

type Unsubscribe = () => void

/** True when the page is running inside a Tauri window rather than Electron. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Subscribe to a Tauri event through the synchronous shape the UI expects.
 *
 * `listen` resolves to its own unsubscribe, which is one turn later than the
 * caller needs it, so unsubscribing before then is remembered and applied when
 * it arrives.
 */
function subscribe<T>(event: string, listener: (payload: T) => void): Unsubscribe {
  let stop: (() => void) | undefined
  let stopped = false

  void listen<T>(event, (message) => listener(message.payload)).then((unlisten) => {
    if (stopped) unlisten()
    else stop = unlisten
  })

  return () => {
    stopped = true
    stop?.()
  }
}

/**
 * Subscribers to something that happens in this page rather than in Rust.
 *
 * Scanning runs here now — the walk and the probe are native calls, but the
 * loop around them is the same TypeScript the Electron build runs in its main
 * process. Its progress therefore never crosses a process boundary, so there
 * is nothing to send and nothing to listen for: the callbacks the UI
 * registered are simply called.
 */
function emitter<T>(): { on: (listener: (value: T) => void) => Unsubscribe; emit: (value: T) => void } {
  const listeners = new Set<(value: T) => void>()
  return {
    on: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (value) => {
      for (const listener of [...listeners]) listener(value)
    }
  }
}

/**
 * The backup record, kept by Rust in the app's data directory.
 *
 * The rules about expiry and removal are in `@shared/plex/backups-store`; this
 * is only where the list lives.
 */
const backups = createBackupRegistry({
  async load(): Promise<BackupRecord[]> {
    const raw = await invoke<string | null>('data_read', { name: 'backups' })
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as BackupRecord[]) : []
    } catch {
      return []
    }
  },
  save: (records) => invoke('data_write', { name: 'backups', contents: JSON.stringify(records, null, 2) })
})

/** The one runner, built when the first repair is asked for. */
let runner: RepairRunner | undefined

const scanProgress = emitter<ScanProgressEvent>()
const scanComplete = emitter<ScanCompleteEvent>()
const jobUpdate = emitter<Job>()

/** Scans that can still be cancelled, by the id the UI gave them. */
const activeScans = new Map<string, AbortController>()

/**
 * The repair runner, built once and kept.
 *
 * Its binaries, concurrency and host can all change between repairs — they are
 * settings, and the queue outlives them — so an existing runner is updated
 * rather than replaced, which would lose whatever is already queued.
 */
async function ensureRunner(): Promise<RepairRunner> {
  const ready = await toolchain()
  if ('problem' in ready) throw new Error(ready.problem)
  const environment = await environmentFor(ready.settings, false)
  if (!environment.ffmpegPath) throw new Error(environment.problem ?? 'FFmpeg is not available.')

  const binaries = {
    ffmpegPath: environment.ffmpegPath,
    ffprobePath: ready.ffprobePath,
    qtFaststartPath: environment.qtFaststartPath
  }

  if (!runner) {
    runner = new RepairRunner(
      binaries,
      ready.settings.concurrency,
      (job) => {
        jobUpdate.emit(job)
        // A finished repair may have made a backup, and is a natural moment to
        // let go of ones that have expired.
        if (job.state === 'done') {
          void backups
            .prune(ready.host, ready.settings.backupRetentionDays)
            .catch((error: unknown) => console.warn('Could not prune backups', error))
        }
      },
      ready.host
    )
    runner.onBackup = (record) => {
      void backups.record(record).catch((error: unknown) => console.warn('Could not record a backup', error))
    }
  } else {
    runner.setBinaries(binaries)
    runner.setConcurrency(ready.settings.concurrency)
    runner.setHost(ready.host)
  }
  return runner
}

async function settingsFrom(promise: Promise<unknown>): Promise<AppSettings> {
  return withDefaults((await promise) as Partial<AppSettings>)
}

/** The toolchain and a host to read through, or a reason there is neither. */
async function toolchain(): Promise<
  { settings: AppSettings; host: ReturnType<typeof tauriHost>; ffprobePath: string } | { problem: string }
> {
  const settings = await settingsFrom(invoke('settings_get'))
  const environment = await environmentFor(settings, false)
  if (!environment.ready || !environment.ffprobePath) {
    return { problem: environment.problem ?? 'FFmpeg is not available.' }
  }
  const local = tauriHost(await localPlatform())
  const target = remoteTargetFor(settings)
  return {
    settings,
    host: target ? remoteHost(target, local) : local,
    ffprobePath: environment.ffprobePath
  }
}

async function environment(force: boolean): Promise<EnvironmentInfo> {
  return environmentFor(await settingsFrom(invoke('settings_get')), force)
}

async function environmentFor(settings: AppSettings, force: boolean): Promise<EnvironmentInfo> {
  // Remote mode asks the far end instead: the binaries that matter are the
  // ones on the machine that will do the work, and so are the encoders.
  const target = remoteTargetFor(settings)
  if (target) return remoteEnvironment(settings, target)

  // The binary paths are not passed: Rust reads them from the settings it
  // saved, so what gets run to be tested is what Settings names and nothing a
  // caller could substitute.
  return invoke('environment_resolve', {
    // The probe runs the real filter chain, so the string comes from the one
    // place that defines it rather than being spelled out again in Rust.
    dolbyVisionFilter: DOLBY_VISION_HDR10_FILTER,
    force
  })
}

async function remoteEnvironment(
  settings: AppSettings,
  target: ReturnType<typeof remoteTargetFor> & {}
): Promise<EnvironmentInfo> {
  const local = tauriHost(await localPlatform())
  const check = await checkRemote({ ...hostKeyTools(local), local }, target, settings)

  if (!check.ok || !check.ffmpegPath || !check.ffprobePath) {
    return {
      ready: false,
      problem: check.problem ?? `Could not use ffmpeg on ${target.host}.`,
      hint: check.hint,
      remote: { host: target.host, platform: check.platform }
    }
  }

  const far = remoteHost(target, local)
  // The test encodes run on the far end, so what comes back is what that
  // machine can really do — an NVENC card in the NAS, not in this laptop.
  const capabilities = await detectEncoders(check.ffmpegPath, {
    exec: (command, args) => far.exec(command, args, { timeoutMs: 60_000 }),
    platform: check.platform?.toLowerCase().includes('darwin') ? 'darwin' : 'linux'
  })

  return {
    ready: true,
    ffmpegPath: check.ffmpegPath,
    ffprobePath: check.ffprobePath,
    qtFaststartPath: check.qtFaststartPath,
    ffmpegSource: settings.remoteFfmpegPath.trim() ? 'settings' : 'path',
    ffprobeSource: settings.remoteFfprobePath.trim() ? 'settings' : 'path',
    ffmpegVersion: check.ffmpegVersion,
    capabilities,
    remote: { host: target.host, platform: check.platform }
  }
}

/** This machine's platform, as Node names it; asked once and kept. */
let platform: string | undefined
async function localPlatform(): Promise<string> {
  platform ??= (await invoke<NativeAbout>('about')).platform
  return platform
}

interface NativeAbout {
  version: string
  packaged: boolean
  tauri: string
  webview: string
  platform: string
  arch: string
  systemVersion: string
  userDataPath: string
}

/**
 * Settings the queue reads while it is already running.
 *
 * How many repairs run at once used to be picked up only when the next batch
 * was queued, so changing it did nothing to the run in front of you. It is now
 * handed over as soon as it is saved: raising it starts more straight away,
 * lowering it starts nothing further until enough have finished. Neither
 * touches a repair that is already under way.
 *
 * Everything else the runner holds — binaries, the host — is deliberately left
 * to the next batch, because those decide what a repair *does* and a queue
 * half-run under each would be two different jobs.
 */
function applyToRunningQueue(settings: AppSettings): void {
  runner?.setConcurrency(settings.concurrency)
}

/** The repair scripts installed now, read and checked. */
async function listScripts(): Promise<ScriptInfo[]> {
  const listings = await invoke<ScriptListing[]>('plugins_list')
  return listings.map(scriptInfo)
}

function buildApi() {
  return {
    settings: {
      get: (): Promise<AppSettings> => settingsFrom(invoke('settings_get')),
      update: async (patch: Partial<AppSettings>): Promise<AppSettings> => {
        const settings = await settingsFrom(invoke('settings_update', { patch }))
        applyToRunningQueue(settings)
        return settings
      },
      reset: async (): Promise<AppSettings> => {
        const settings = await settingsFrom(invoke('settings_reset'))
        applyToRunningQueue(settings)
        return settings
      }
    },
    overrides: {
      get: (): Promise<ModeOverrides> => invoke('overrides_get'),
      set: (path: string, mode: RepairMode | null): Promise<ModeOverrides> =>
        invoke('overrides_set', { path, mode })
    },
    environment: {
      get: (): Promise<EnvironmentInfo> => environment(false),
      refresh: (): Promise<EnvironmentInfo> => environment(true)
    },
    remote: {
      check: async (): Promise<RemoteCheck> => {
        const settings = await settingsFrom(invoke('settings_get'))
        // Testing is useful before the switch is on, so the target is built as
        // though it were.
        const target = remoteTargetFor({ ...settings, remoteEnabled: true })
        if (!target) return { ok: false, host: settings.remoteHost, missing: [], found: [], problem: 'Enter the host to connect to first.' }
        const local = tauriHost(await localPlatform())
        return checkRemote({ ...hostKeyTools(local), local }, target, settings)
      },
      list: async (path?: string): Promise<RemoteListing> => {
        const settings = await settingsFrom(invoke('settings_get'))
        const target = remoteTargetFor({ ...settings, remoteEnabled: true })
        if (!target) return { path: '/', entries: [], problem: 'Enter the host to connect to first.' }
        const local = tauriHost(await localPlatform())
        const far = remoteHost(target, local)

        let directory = startDirectory(path, settings.remoteDefaultPath)
        try {
          // Neither a path nor a default folder means "wherever this account
          // starts", which is somewhere to begin even if it is rarely the library.
          if (!directory) directory = (await far.exec('sh', ['-c', 'echo "$HOME"'])).trim() || '/'
          const extensions = new Set(settings.mediaExtensions.map((ext) => ext.toLowerCase().replace(/^\./, '')))
          const entries = (await far.list(directory))
            // Dot-entries are PlexFixer's own backups, caches and system
            // clutter; a library folder is not hidden.
            .filter((entry) => !entry.name.startsWith('.'))
            .map((entry) => ({
              name: entry.name,
              path: far.paths.join(directory, entry.name),
              isDirectory: entry.isDirectory,
              sizeBytes: entry.sizeBytes,
              isMedia: !entry.isDirectory && extensions.has(far.paths.extname(entry.name).slice(1).toLowerCase())
            }))
            .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
          return {
            path: directory,
            parent: directory === '/' ? undefined : far.paths.dirname(directory),
            entries
          }
        } catch (error) {
          return {
            path: directory || '/',
            entries: [],
            problem: error instanceof Error ? error.message : String(error)
          }
        }
      },
      // `shown` is what was on screen when the button was pressed: only a key
      // with one of those fingerprints is recorded.
      trustHost: async (shown: HostKeyFingerprint[]): Promise<RemoteCheck> => {
        const settings = await settingsFrom(invoke('settings_get'))
        const target = remoteTargetFor({ ...settings, remoteEnabled: true })
        if (!target) return { ok: false, host: settings.remoteHost, missing: [], found: [], problem: 'Enter the host to connect to first.' }
        const local = tauriHost(await localPlatform())
        const tools = { ...hostKeyTools(local), local }

        const trusted = await trustHost(tools, target, shown)
        if (!trusted.ok) {
          return {
            ok: false,
            host: target.host,
            missing: [],
            found: [],
            problem: trusted.problem,
            hint: trusted.hint,
            fingerprints: trusted.fingerprints
          }
        }
        // Recording the key is only worth doing to get past it, so the
        // connection is tested again in the same step.
        const check = await checkRemote(tools, target, settings)
        return { ...check, fingerprints: check.fingerprints ?? trusted.fingerprints }
      },
      pickKeyFile: async (): Promise<string | undefined> => {
        const picked = await openDialog({
          title: 'Choose a private key',
          multiple: false,
          directory: false
        })
        return picked ?? undefined
      }
    },
    dialog: {
      // Files and folders are two dialogs, not one. The native picker is in
      // one mode or the other — `directory: false` is a file picker that will
      // not let a folder be chosen at all — so an app that offers only this
      // one cannot be pointed at a library, which is the ordinary case.
      pickPaths: async (): Promise<string[]> => {
        const picked = await openDialog({ multiple: true, directory: false })
        return picked ?? []
      },
      pickFolders: async (): Promise<string[]> => {
        // `multiple` so several libraries can be added at once; each is walked
        // to its full depth by the scan, which is what makes this the normal
        // way in rather than a shortcut. `recursive` widens the scope granted
        // over what was picked to everything beneath it — the walk itself runs
        // in Rust and is not bound by that scope, but anything later reached
        // for through a plugin would be.
        const picked = await openDialog({ multiple: true, directory: true, recursive: true })
        return picked ?? []
      },
      pickDirectory: async (): Promise<string | undefined> => {
        const picked = await openDialog({ directory: true, multiple: false })
        return picked ?? undefined
      },
      pickBinary: async (name: 'ffmpeg' | 'ffprobe'): Promise<string | undefined> => {
        const picked = await openDialog({ title: `Choose ${name}`, multiple: false, directory: false })
        return picked ?? undefined
      }
    },
    scan: {
      start: async (paths: string[], scanId: string): Promise<string> => {
        const controller = new AbortController()
        activeScans.set(scanId, controller)

        const ready = await toolchain()
        if ('problem' in ready) {
          scanComplete.emit({
            scanId,
            inputPaths: paths,
            errors: [{ path: paths[0] ?? '', message: ready.problem }],
            foundPaths: [],
            // Nothing was looked at, so nothing in the library should be dropped.
            cancelled: true
          })
          activeScans.delete(scanId)
          return scanId
        }

        // What has already been probed, so the scan can leave untouched files
        // alone. Read here rather than handed in: the library is this window's
        // own database, and threading thousands of entries through the bridge
        // to give them straight back would be work for its own sake.
        const known = new Map<string, KnownFile>()
        try {
          for (const entry of await loadLibrary()) {
            known.set(entry.path, { sizeBytes: entry.file.sizeBytes, modifiedMs: entry.file.modifiedMs })
          }
        } catch (error) {
          // A library that cannot be read is not a reason to refuse to scan;
          // it only means everything is read again, as it used to be.
          console.error('Could not read the library, so everything will be probed', error)
        }

        // Deliberately not awaited: the UI records the id and then watches the
        // events, exactly as it does under Electron.
        void runScan({
          scanId,
          inputPaths: paths,
          settings: ready.settings,
          host: ready.host,
          ffprobePath: ready.ffprobePath,
          // Called on the host, not taken off it: a remote host's `findMedia`
          // reaches for the rest of the host to do its work, and a bare
          // reference arrives with nothing to reach for. This is why a scan in
          // remote mode found nothing at all.
          findMedia: (roots, extensions, recursive) => ready.host.findMedia(roots, extensions, recursive),
          known,
          signal: controller.signal,
          onProgress: (event) => scanProgress.emit(event)
        })
          .then((complete) => scanComplete.emit(complete))
          .catch((error: unknown) => {
            scanComplete.emit({
              scanId,
              inputPaths: paths,
              errors: [{ path: paths[0] ?? '', message: error instanceof Error ? error.message : String(error) }],
              foundPaths: [],
              cancelled: true
            })
          })
          .finally(() => activeScans.delete(scanId))

        return scanId
      },
      rescanFile: async (path: string): Promise<RescanResult> => {
        const ready = await toolchain()
        if ('problem' in ready) return { error: ready.problem }
        // An in-place repair that changed container renames the file, so the
        // path the row was built from may no longer exist. Say so rather than
        // reporting it as unreadable.
        if (!(await ready.host.stat(path))) return { missing: true }
        try {
          const probed = await probeFile(path, { ffprobePath: ready.ffprobePath, host: ready.host })
          return { result: { ...analyzeFile(probed, ready.settings), scannedAt: Date.now() } }
        } catch (error) {
          return {
            error:
              error instanceof ProbeError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : String(error)
          }
        }
      },
      cancel: async (scanId: string): Promise<boolean> => {
        const controller = activeScans.get(scanId)
        controller?.abort()
        return controller != null
      },
      onProgress: (listener: (event: ScanProgressEvent) => void): Unsubscribe => scanProgress.on(listener),
      onComplete: (listener: (event: ScanCompleteEvent) => void): Unsubscribe => scanComplete.on(listener)
    },
    backups: {
      summary: async (roots: string[]): Promise<{ count: number; bytes: number }> => {
        const ready = await toolchain()
        if ('problem' in ready) throw new Error(ready.problem)
        const { files, bytes } = await findBackups(roots, ready.host)
        return { count: files.length, bytes }
      },
      removeAll: async (roots: string[]): Promise<{ removed: number; bytes: number }> => {
        const ready = await toolchain()
        if ('problem' in ready) throw new Error(ready.problem)
        return backups.removeAll(roots, ready.host)
      }
    },
    jobs: {
      enqueue: async (requests: RepairRequest[], mode?: RepairMode): Promise<Job[]> => {
        const active = await ensureRunner()
        // Opened before the first slow step, so that cancelling during the
        // setup counts too and not only once files start arriving.
        const batch = active.beginBatch()
        try {
          const overrides = await invoke<ModeOverrides>('overrides_get')
          const ready = await toolchain()
          if ('problem' in ready) throw new Error(ready.problem)
          const environment = await environmentFor(ready.settings, false)
          // Read once per batch, so a script approved or edited meanwhile is
          // seen as it is now; the native side checks again before running it.
          const scripts = await listScripts()

          const jobs: Job[] = []
          for (const request of requests) {
            if (batch.cancelled) break
            // Analysed now, with today's settings, so the plan matches what the
            // table shows rather than whatever was true when it was scanned.
            const probed = await probeFile(request.file.path, {
              ffprobePath: ready.ffprobePath,
              host: ready.host
            })
            // Checked again: the probe is the slow part, and a file probed
            // before the click must not be queued after it.
            if (batch.cancelled) break
            jobs.push(
              active.enqueue({
                result: analyzeFile(probed, ready.settings),
                settings: ready.settings,
                mode: repairModeFor(probed.path, overrides, ready.settings.defaultMode, mode),
                caps: environment.capabilities,
                scanRoot: request.scanRoot,
                scripts
              })
            )
          }
          return jobs
        } finally {
          batch.finish()
        }
      },
      list: (): Promise<Job[]> => Promise.resolve(runner?.list() ?? []),
      cancel: async (id: string): Promise<boolean> => runner?.cancel(id) ?? false,
      /** Resolves to the ids dropped before starting, for the window to remove. */
      cancelAll: async (): Promise<string[]> => runner?.cancelAll() ?? [],
      clearFinished: async (): Promise<void> => runner?.clearFinished(),
      clearQueued: async (): Promise<number> => runner?.clearQueued() ?? 0,
      onUpdate: (listener: (job: Job) => void): Unsubscribe => jobUpdate.on(listener)
    },
    scripts: {
      /** Every folder under the repairs directory, read and checked. */
      list: listScripts,
      /** Shows the native approval dialog; resolves true when approved. */
      approve: (id: string): Promise<boolean> => invoke<boolean>('plugins_trust', { id }),
      revoke: (id: string): Promise<void> => invoke('plugins_revoke', { id }),
      /** Creates the repairs folder if need be, and shows it. */
      openFolder: async (): Promise<void> => revealItemInDir(await invoke<string>('plugins_folder'))
    },
    shell: {
      reveal: (path: string): Promise<void> => revealItemInDir(path),
      fileMenu: (path: string): Promise<void> => invoke('file_context_menu', { path })
    },
    app: {
      initialPaths: async (): Promise<string[]> => {
        const argv = await invoke<string[]>('launch_args')
        const launch = parseLaunchArgs(argv)
        for (const problem of launch.problems) console.error(`plexfixer: ${problem}`)
        return launch.volumes
      },
      about: async (): Promise<AboutInfo> => {
        const native = await invoke<NativeAbout>('about')
        return {
          version: native.version,
          packaged: native.packaged,
          tauri: native.tauri,
          webview: native.webview,
          platform: native.platform,
          arch: native.arch,
          systemVersion: native.systemVersion,
          userDataPath: native.userDataPath
        }
      },
      saveText: async (suggestedName: string, contents: string): Promise<string | undefined> => {
        const path = await saveDialog({ defaultPath: suggestedName })
        if (!path) return undefined
        return invoke<string>('save_text', { path, contents })
      },
      onShowAbout: (listener: () => void): Unsubscribe => subscribe('plexfixer://show-about', listener),
      onOpenPaths: (listener: (paths: string[]) => void): Unsubscribe =>
        subscribe<string[]>('plexfixer://open-paths', listener),
      /**
       * Paths dropped on the window.
       *
       * Tauri handles the drop itself when the window has drag-and-drop
       * enabled, so the page never sees a `drop` event carrying files. Kept
       * apart from `onOpenPaths` because a drop means something different in
       * remote mode, where a local path is no use.
       */
      onDroppedPaths: (listener: (paths: string[]) => void): Unsubscribe =>
        subscribe<{ paths?: string[] }>('tauri://drag-drop', (payload) => {
          if (payload?.paths?.length) listener(payload.paths)
        }),
      /** Whether a file is being dragged over the window, for the highlight. */
      onDragState: (listener: (active: boolean) => void): Unsubscribe => {
        const stops = [
          subscribe('tauri://drag-enter', () => listener(true)),
          subscribe('tauri://drag-leave', () => listener(false)),
          subscribe('tauri://drag-drop', () => listener(false))
        ]
        return () => {
          for (const stop of stops) stop()
        }
      }
    },
  }

}

/** The shape the whole UI is written against. */
export type PlexFixerApi = ReturnType<typeof buildApi>

export function installTauriBridge(): void {
  // Copy Path on the right-click menu: the menu is native, the clipboard is
  // the webview's.
  void subscribe<string>('plexfixer://copy-path', (path) => {
    void navigator.clipboard?.writeText(path)
  })

  window.plexfixer = buildApi()
}
