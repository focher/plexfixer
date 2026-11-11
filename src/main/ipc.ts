/**
 * IPC surface exposed to the renderer.
 *
 * Every handler is request/response except scan progress and job updates, which
 * are pushed to the window as events.
 */

import { randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AnalysisResult,
  AppSettings,
  Job,
  MediaFile,
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
import { collectMediaFiles } from './scan/walk.js'
import { getSettings, resetSettings, updateSettings } from './settings.js'
import { invalidateEnvironment, resolveEnvironment, type Environment } from './environment.js'
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
  if (!runner) {
    runner = new RepairRunner(binaries, settings.concurrency, (job: Job) => send(IPC.jobUpdate, job))
  } else {
    runner.setBinaries(binaries)
    runner.setConcurrency(settings.concurrency)
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
    try {
      await access(filePath)
    } catch {
      // An in-place repair that changed container renames the file, so the path
      // the row was built from no longer exists. Say so rather than erroring.
      return { missing: true }
    }
    try {
      const probed = await probeFile(filePath, { ffprobePath: environment.ffprobePath })
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

  ipcMain.handle(IPC.jobsEnqueue, async (_event, requests: RepairRequest[], mode: RepairMode): Promise<Job[]> => {
    const settings = await getSettings()
    const environment = await resolveEnvironment(settings)
    const activeRunner = await ensureRunner(settings, environment)

    const jobs: Job[] = []
    for (const request of requests) {
      const file = await currentProbe(request.file, environment)
      if (!file) continue
      // Analysed now, with today's settings, so the plan matches what the
      // table shows rather than whatever was true when the file was scanned.
      const result = analyzeFile(file, settings)
      jobs.push(
        activeRunner.enqueue({
          result,
          settings,
          mode,
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

  /* --- shell -------------------------------------------------------------- */

  ipcMain.handle(IPC.revealPath, async (_event, path: string): Promise<void> => {
    shell.showItemInFolder(path)
  })

  // Paths the app was launched with, consumed once by the renderer on startup.
  ipcMain.handle(IPC.initialPaths, async (): Promise<string[]> => takeQueuedPaths())
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
async function currentProbe(stored: MediaFile, environment: Environment): Promise<MediaFile | undefined> {
  if (!stored || typeof stored.path !== 'string') return undefined
  const info = await stat(stored.path).catch(() => undefined)
  if (!info?.isFile()) return undefined
  if (stored.modifiedMs != null && info.mtimeMs === stored.modifiedMs && info.size === stored.sizeBytes) return stored
  if (!environment.ffprobePath) return undefined
  try {
    return await probeFile(stored.path, { ffprobePath: environment.ffprobePath })
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
      results: [],
      errors: [{ path: inputPaths[0] ?? '', message: environment.problem ?? 'FFmpeg is not available.' }],
      foundPaths: [],
      // Nothing was looked at, so nothing in the library should be dropped.
      cancelled: true
    } satisfies ScanCompleteEvent)
    return
  }

  const files = await collectMediaFiles(inputPaths, {
    extensions: settings.mediaExtensions,
    recursive: settings.recursive
  })

  send(IPC.scanProgress, { scanId, processed: 0, total: files.length } satisfies ScanProgressEvent)

  const results: AnalysisResult[] = []
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
      try {
        const probed = await probeFile(filePath, { ffprobePath: environment.ffprobePath! })
        results.push({
          ...analyzeFile(probed, settings),
          scannedAt: Date.now(),
          scanRoot: await scanRootFor(inputPaths, filePath)
        })
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
          currentPath: filePath
        } satisfies ScanProgressEvent)
      }
    }
  }

  await Promise.all(Array.from({ length: parallelism }, worker))

  results.sort((a, b) => a.file.path.localeCompare(b.file.path))
  send(IPC.scanComplete, {
    scanId,
    inputPaths,
    results,
    errors,
    foundPaths: files,
    cancelled: signal.aborted
  } satisfies ScanCompleteEvent)
}
