/**
 * IPC surface exposed to the renderer.
 *
 * Every handler is request/response except scan progress and job updates, which
 * are pushed to the window as events.
 */

import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, shell } from 'electron'
import type {
  AboutInfo,
  AnalysisResult,
  AppSettings,
  RemoteCheck,
  RemoteEntry,
  RemoteListing,
  Job,
  MediaFile,
  ModeOverrides,
  RepairMode,
  RepairRequest,
  ScanCompleteEvent,
  RescanResult,
  ScanError,
  ScanProgressEvent
} from '@shared/types.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { IPC } from '@shared/ipc.js'
import { probeFile, ProbeError } from './ffmpeg/probe.js'
import { getModeOverrides, getSettings, resetSettings, setModeOverride, updateSettings } from './settings.js'
import { repairModeFor } from '@shared/mode.js'
import { invalidateEnvironment, resolveEnvironment, type Environment } from './environment.js'
import { hostFor, remoteHost, remoteTargetFor, type Host } from './host.js'
import { checkRemote } from './remote/check.js'
import { trustHost } from './remote/hostkey.js'
import { RepairRunner } from './jobs/runner.js'
import { scanRootFor } from './jobs/output.js'
import { takeQueuedPaths } from './openPaths.js'

interface ActiveScan {
  controller: AbortController
  inputPaths: string[]
}

const activeScans = new Map<string, ActiveScan>()
let runner: RepairRunner | undefined

function send(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

async function ensureRunner(settings: AppSettings, environment: Environment): Promise<RepairRunner> {
  if (!environment.ready || !environment.ffmpegPath || !environment.ffprobePath) {
    throw new Error(environment.problem ?? 'FFmpeg is not available.')
  }
  const binaries = { ffmpegPath: environment.ffmpegPath, ffprobePath: environment.ffprobePath }
  const host = hostFor(settings)
  if (!runner) {
    runner = new RepairRunner(binaries, settings.concurrency, (job: Job) => send(IPC.jobUpdate, job), host)
  } else {
    runner.setBinaries(binaries)
    runner.setConcurrency(settings.concurrency)
    // The host can change between repairs: remote mode is a setting, and the
    // queue outlives it.
    runner.setHost(host)
  }
  return runner
}

export function registerIpcHandlers(): void {
  /* --- settings ------------------------------------------------------- */

  ipcMain.handle(IPC.settingsGet, async (): Promise<AppSettings> => getSettings())

  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: Partial<AppSettings>): Promise<AppSettings> => {
    const next = await updateSettings(patch)
    // A changed binary path invalidates the cached capability probe.
    if ('ffmpegPath' in patch || 'ffprobePath' in patch) invalidateEnvironment()
    runner?.setConcurrency(next.concurrency)
    return next
  })

  ipcMain.handle(IPC.settingsReset, async (): Promise<AppSettings> => {
    invalidateEnvironment()
    return resetSettings()
  })

  ipcMain.handle(IPC.overridesGet, async (): Promise<ModeOverrides> => getModeOverrides())

  ipcMain.handle(
    IPC.overridesSet,
    async (_event, path: string, mode: RepairMode | null): Promise<ModeOverrides> => setModeOverride(path, mode)
  )

  /* --- environment ----------------------------------------------------- */

  ipcMain.handle(IPC.envGet, async (): Promise<Environment> => resolveEnvironment(await getSettings()))

  ipcMain.handle(IPC.envRefresh, async (): Promise<Environment> => {
    invalidateEnvironment()
    return resolveEnvironment(await getSettings(), true)
  })

  /* --- dialogs --------------------------------------------------------- */

  ipcMain.handle(IPC.pickPaths, async (event): Promise<string[]> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const settings = await getSettings()
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: 'Choose media files or folders',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'Media', extensions: settings.mediaExtensions }]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.pickDirectory, async (event): Promise<string | undefined> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: 'Choose an output folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? undefined : result.filePaths[0]
  })

  ipcMain.handle(IPC.pickBinary, async (event, name: 'ffmpeg' | 'ffprobe'): Promise<string | undefined> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: `Choose the ${name} executable`,
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Executable', extensions: ['exe'] }] : []
    })
    return result.canceled ? undefined : result.filePaths[0]
  })

  /* --- scanning --------------------------------------------------------- */

  ipcMain.handle(IPC.scanStart, async (_event, paths: string[], requestedId?: string): Promise<string> => {
    // The renderer supplies the id so it can record it *before* awaiting this
    // call. Otherwise a scan that finishes quickly can emit `scan:complete`
    // before the renderer knows which id to match it against, and the results
    // are silently dropped.
    const scanId = typeof requestedId === 'string' && /^[\w-]{1,64}$/.test(requestedId) ? requestedId : randomUUID()
    const controller = new AbortController()
    activeScans.set(scanId, { controller, inputPaths: paths })

    void runScan(scanId, paths, controller.signal).finally(() => activeScans.delete(scanId))

    return scanId
  })

  /**
   * Re-analyse one file without disturbing the rest of the table.
   *
   * A full rescan throws away every row and every selection, which is the wrong
   * tool for "did my repair actually fix this one?".
   */
  ipcMain.handle(IPC.rescanFile, async (_event, filePath: string): Promise<RescanResult> => {
    const settings = await getSettings()
    const environment = await resolveEnvironment(settings)
    if (!environment.ready || !environment.ffprobePath) {
      return { error: environment.problem ?? 'ffprobe is not available' }
    }
    const host = hostFor(settings)
    if (!(await host.exists(filePath))) {
      // An in-place repair that changed container renames the file, so the path
      // the row was built from no longer exists. Say so rather than erroring.
      return { missing: true }
    }
    try {
      const probed = await probeFile(filePath, { ffprobePath: environment.ffprobePath, host })
      // The renderer keeps the row's scan root; it is not known here.
      return { result: { ...analyzeFile(probed, settings), scannedAt: Date.now() } }
    } catch (error) {
      return { error: error instanceof ProbeError ? error.message : error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC.scanCancel, async (_event, scanId: string): Promise<boolean> => {
    const scan = activeScans.get(scanId)
    if (!scan) return false
    scan.controller.abort()
    return true
  })

  /* --- jobs -------------------------------------------------------------- */

  // `mode` forces one mode on the whole batch, for the explicit "Force
  // transcode selected" style buttons. Left out, each file gets the mode its
  // own override — or its folder's, or the global default — resolves to.
  //
  // Report-only is the exception an explicit mode cannot override: a file, or a
  // folder, set to report-only is never written to, however the repair was
  // started. The job is still queued, so the Jobs tab says it was skipped
  // rather than the click doing nothing.
  ipcMain.handle(IPC.jobsEnqueue, async (_event, requests: RepairRequest[], mode?: RepairMode): Promise<Job[]> => {
    const settings = await getSettings()
    const environment = await resolveEnvironment(settings)
    const activeRunner = await ensureRunner(settings, environment)
    const overrides = await getModeOverrides()

    const jobs: Job[] = []
    for (const request of requests) {
      const file = await currentProbe(request.file, environment, hostFor(settings))
      if (!file) continue
      // Analysed now, with today's settings, so the plan matches what the
      // table shows rather than whatever was true when the file was scanned.
      const result = analyzeFile(file, settings)
      jobs.push(
        activeRunner.enqueue({
          result,
          settings,
          mode: repairModeFor(file.path, overrides, settings.defaultMode, mode),
          caps: environment.capabilities,
          scanRoot: request.scanRoot
        })
      )
    }
    return jobs
  })

  ipcMain.handle(IPC.jobsList, async (): Promise<Job[]> => runner?.list() ?? [])

  ipcMain.handle(IPC.jobsCancel, async (_event, id: string): Promise<boolean> => runner?.cancel(id) ?? false)

  ipcMain.handle(IPC.jobsCancelAll, async (): Promise<void> => runner?.cancelAll())

  ipcMain.handle(IPC.jobsClear, async (): Promise<void> => runner?.clearFinished())

  ipcMain.handle(IPC.jobsClearQueued, async (): Promise<number> => runner?.clearQueued() ?? 0)

  /* --- shell -------------------------------------------------------------- */

  ipcMain.handle(IPC.revealPath, async (_event, path: string): Promise<void> => {
    shell.showItemInFolder(path)
  })

  // The right-click menu on a library row. Native rather than drawn in HTML so
  // it looks and behaves like every other context menu on the platform.
  ipcMain.handle(IPC.fileContextMenu, async (event, path: string): Promise<void> => {
    if (typeof path !== 'string' || path.length === 0) return
    const revealLabel =
      process.platform === 'darwin'
        ? 'Reveal in Finder'
        : process.platform === 'win32'
          ? 'Show in File Explorer'
          : 'Show in Folder'
    Menu.buildFromTemplate([
      { label: revealLabel, click: () => shell.showItemInFolder(path) },
      { label: 'Copy Path', click: () => clipboard.writeText(path) }
    ]).popup({ window: BrowserWindow.fromWebContents(event.sender) ?? undefined })
  })

  // Paths the app was launched with, consumed once by the renderer on startup.
  ipcMain.handle(IPC.initialPaths, async (): Promise<string[]> => takeQueuedPaths())

  // The build and the runtime under it. Only the main process knows any of
  // this: the renderer has no Node and no `app`, by design.
  ipcMain.handle(IPC.about, async (): Promise<AboutInfo> => aboutInfo())

  /* --- the machine that holds the files ---------------------------------- */

  // Tested with whatever is typed in, enabled or not: the point of the button
  // is to find out before committing to it.
  ipcMain.handle(IPC.remoteCheck, async (): Promise<RemoteCheck> => {
    const settings = await getSettings()
    const target = remoteTargetFor({ ...settings, remoteEnabled: true })
    if (!target) {
      return { ok: false, host: '', missing: [], found: [], problem: 'Enter the host to connect to first.' }
    }
    const check = await checkRemote(target, settings)
    // A successful test should take effect without a restart.
    if (check.ok) invalidateEnvironment()
    return check
  })

  /**
   * Record the host's key, then test again.
   *
   * This is the "yes" to SSH's first-connection question, which a batch-mode
   * connection cannot ask. It writes nothing unless the user pressed the
   * button, and `trustHost` refuses outright when a *different* key is already
   * recorded for that host.
   */
  ipcMain.handle(IPC.remoteTrustHost, async (): Promise<RemoteCheck> => {
    const settings = await getSettings()
    const target = remoteTargetFor({ ...settings, remoteEnabled: true })
    if (!target) {
      return { ok: false, host: '', missing: [], found: [], problem: 'Enter the host to connect to first.' }
    }
    const trusted = await trustHost(target)
    if (!trusted.ok) {
      return {
        ok: false,
        host: target.host,
        missing: [],
        found: [],
        problem: trusted.problem,
        hint: trusted.hint,
        hostKeyChanged: true
      }
    }
    const check = await checkRemote(target, settings)
    if (check.ok) invalidateEnvironment()
    // Say what was recorded, whatever the connection then made of it.
    return { ...check, fingerprints: check.fingerprints ?? trusted.fingerprints }
  })

  ipcMain.handle(IPC.pickKeyFile, async (): Promise<string | undefined> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose a private key',
      // `~/.ssh` is hidden, which is where every key people have lives.
      defaultPath: join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent']
    })
    return canceled ? undefined : filePaths[0]
  })

  ipcMain.handle(IPC.remoteList, async (_event, path?: string): Promise<RemoteListing> => {
    const settings = await getSettings()
    const target = remoteTargetFor({ ...settings, remoteEnabled: true })
    if (!target) return { path: '/', entries: [], problem: 'Enter the host to connect to first.' }
    const host = remoteHost(target)

    let directory = typeof path === 'string' ? path.trim() : ''
    try {
      // No path means "wherever this account starts", which is the useful
      // place to begin looking for a library.
      if (!directory) directory = (await host.exec('sh', ['-c', 'echo \"$HOME\"'])).trim() || '/'
      const extensions = new Set(settings.mediaExtensions.map((ext) => ext.toLowerCase().replace(/^\./, '')))
      const entries: RemoteEntry[] = (await host.list(directory))
        // Dot-entries are PlexFixer's own backups, caches and system clutter;
        // a library folder is not hidden.
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          path: host.paths.join(directory, entry.name),
          isDirectory: entry.isDirectory,
          sizeBytes: entry.sizeBytes,
          isMedia: !entry.isDirectory && extensions.has(host.paths.extname(entry.name).slice(1).toLowerCase())
        }))
        .sort((a, b) =>
          a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
        )
      return {
        path: directory,
        parent: directory === '/' ? undefined : host.paths.dirname(directory),
        entries
      }
    } catch (error) {
      return {
        path: directory || '/',
        entries: [],
        problem: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // Save a report the user asked for. The renderer can compose text but cannot
  // write a file, and a diagnostics bundle is usually too long to paste.
  ipcMain.handle(
    IPC.saveText,
    async (event, suggestedName: string, contents: string): Promise<string | undefined> => {
      if (typeof suggestedName !== 'string' || typeof contents !== 'string') return undefined
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const { canceled, filePath } = await (window
        ? dialog.showSaveDialog(window, saveOptions(suggestedName))
        : dialog.showSaveDialog(saveOptions(suggestedName)))
      if (canceled || !filePath) return undefined
      await writeFile(filePath, contents, 'utf8')
      return filePath
    }
  )
}

function saveOptions(suggestedName: string): Electron.SaveDialogOptions {
  return {
    title: 'Save diagnostics',
    defaultPath: join(app.getPath('downloads'), suggestedName),
    filters: [{ name: 'Text', extensions: ['txt'] }]
  }
}

function aboutInfo(): AboutInfo {
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    // Electron's own reading of the OS version, which is the one the user
    // would recognise rather than a kernel build number.
    systemVersion: process.getSystemVersion(),
    userDataPath: app.getPath('userData')
  }
}

/* ------------------------------------------------------------------ *
 * Scan implementation
 * ------------------------------------------------------------------ */

/**
 * The probe to repair from: the library's stored one when the file on disk is
 * still the file that was scanned (same size and modification time), a fresh
 * probe when it has changed, or nothing when it is gone or unreadable.
 *
 * A repair planned from a stale probe could map streams that no longer exist,
 * and the library may hold scans from weeks ago.
 */
async function currentProbe(
  stored: MediaFile,
  environment: Environment,
  host: Host
): Promise<MediaFile | undefined> {
  if (!stored || typeof stored.path !== 'string') return undefined
  const info = await host.stat(stored.path)
  if (!info || info.isDirectory) return undefined
  if (stored.modifiedMs != null && info.modifiedMs === stored.modifiedMs && info.sizeBytes === stored.sizeBytes) {
    return stored
  }
  if (!environment.ffprobePath) return undefined
  try {
    return await probeFile(stored.path, { ffprobePath: environment.ffprobePath, host })
  } catch {
    return undefined
  }
}

async function runScan(scanId: string, inputPaths: string[], signal: AbortSignal): Promise<void> {
  const settings = await getSettings()
  const environment = await resolveEnvironment(settings)

  if (!environment.ready || !environment.ffprobePath) {
    send(IPC.scanComplete, {
      scanId,
      inputPaths,
      errors: [{ path: inputPaths[0] ?? '', message: environment.problem ?? 'FFmpeg is not available.' }],
      foundPaths: [],
      // Nothing was looked at, so nothing in the library should be dropped.
      cancelled: true
    } satisfies ScanCompleteEvent)
    return
  }

  const host = hostFor(settings)
  const files = await host.findMedia(inputPaths, settings.mediaExtensions, settings.recursive)

  send(IPC.scanProgress, { scanId, processed: 0, total: files.length } satisfies ScanProgressEvent)

  const errors: ScanError[] = []

  // ffprobe is I/O bound and cheap; a small amount of parallelism keeps a
  // network share from dominating the wall-clock time without thrashing it.
  const parallelism = Math.max(1, Math.min(8, settings.concurrency * 2))
  let cursor = 0
  let processed = 0

  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = cursor++
      if (index >= files.length) return
      const filePath = files[index]
      let result: AnalysisResult | undefined
      try {
        const probed = await probeFile(filePath, { ffprobePath: environment.ffprobePath!, host })
        result = {
          ...analyzeFile(probed, settings),
          scannedAt: Date.now(),
          scanRoot: await scanRootFor(inputPaths, filePath, host)
        }
      } catch (error) {
        errors.push({
          path: filePath,
          message: error instanceof ProbeError ? error.message : error instanceof Error ? error.message : String(error)
        })
      } finally {
        processed++
        send(IPC.scanProgress, {
          scanId,
          processed,
          total: files.length,
          currentPath: filePath,
          result
        } satisfies ScanProgressEvent)
      }
    }
  }

  await Promise.all(Array.from({ length: parallelism }, worker))

  send(IPC.scanComplete, {
    scanId,
    inputPaths,
    errors,
    foundPaths: files,
    cancelled: signal.aborted
  } satisfies ScanCompleteEvent)
}
