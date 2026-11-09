/**
 * IPC surface exposed to the renderer.
 *
 * Every handler is request/response except scan progress and job updates, which
 * are pushed to the window as events.
 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AnalysisResult,
  AppSettings,
  Job,
  ModeOverrides,
  RepairMode,
  ScanCompleteEvent,
  ScanError,
  ScanProgressEvent
} from '@shared/types.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { IPC } from '@shared/ipc.js'
import { probeFile, ProbeError } from './ffmpeg/probe.js'
import { collectMediaFiles } from './scan/walk.js'
import { getModeOverrides, getSettings, resetSettings, resolveMode, setModeOverride, updateSettings } from './settings.js'
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
/** Latest analysis per path, so a repair can be queued without re-scanning. */
const resultsByPath = new Map<string, AnalysisResult>()
const scanRootByPath = new Map<string, string | undefined>()

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

  ipcMain.handle(IPC.scanCancel, async (_event, scanId: string): Promise<boolean> => {
    const scan = activeScans.get(scanId)
    if (!scan) return false
    scan.controller.abort()
    return true
  })

  /* --- jobs -------------------------------------------------------------- */

  ipcMain.handle(IPC.jobsEnqueue, async (_event, paths: string[], modeOverride?: RepairMode): Promise<Job[]> => {
    const settings = await getSettings()
    const environment = await resolveEnvironment(settings)
    const activeRunner = await ensureRunner(settings, environment)
    const overrides = await getModeOverrides()

    const jobs: Job[] = []
    for (const path of paths) {
      const result = resultsByPath.get(path)
      if (!result) continue
      const mode = modeOverride ?? resolveMode(path, overrides, settings.defaultMode)
      jobs.push(
        activeRunner.enqueue({
          result,
          settings,
          mode,
          caps: environment.capabilities,
          scanRoot: scanRootByPath.get(path)
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

async function runScan(scanId: string, inputPaths: string[], signal: AbortSignal): Promise<void> {
  const settings = await getSettings()
  const environment = await resolveEnvironment(settings)

  if (!environment.ready || !environment.ffprobePath) {
    send(IPC.scanComplete, {
      scanId,
      results: [],
      errors: [{ path: inputPaths[0] ?? '', message: environment.problem ?? 'FFmpeg is not available.' }]
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
        const result = analyzeFile(probed, settings)
        results.push(result)
        resultsByPath.set(filePath, result)
        scanRootByPath.set(filePath, await scanRootFor(inputPaths, filePath))
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
  send(IPC.scanComplete, { scanId, results, errors } satisfies ScanCompleteEvent)
}
