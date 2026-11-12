/**
 * The renderer's only access to the main process.
 *
 * Nothing here takes a callback *from* the renderer into privileged code; the
 * event subscriptions wrap the listener so the raw `IpcRendererEvent` is never
 * handed across the bridge.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AboutInfo,
  AppSettings,
  EnvironmentInfo,
  Job,
  ModeOverrides,
  RepairMode,
  RepairRequest,
  RescanResult,
  ScanCompleteEvent,
  ScanProgressEvent
} from '@shared/types.js'
import { IPC } from '@shared/ipc.js'

type Unsubscribe = () => void

const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    reset: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsReset)
  },
  overrides: {
    get: (): Promise<ModeOverrides> => ipcRenderer.invoke(IPC.overridesGet),
    /** `null` clears the override on that path. */
    set: (path: string, mode: RepairMode | null): Promise<ModeOverrides> =>
      ipcRenderer.invoke(IPC.overridesSet, path, mode)
  },
  environment: {
    get: (): Promise<EnvironmentInfo> => ipcRenderer.invoke(IPC.envGet),
    refresh: (): Promise<EnvironmentInfo> => ipcRenderer.invoke(IPC.envRefresh)
  },
  dialog: {
    pickPaths: (): Promise<string[]> => ipcRenderer.invoke(IPC.pickPaths),
    pickDirectory: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.pickDirectory),
    pickBinary: (name: 'ffmpeg' | 'ffprobe'): Promise<string | undefined> =>
      ipcRenderer.invoke(IPC.pickBinary, name)
  },
  scan: {
    start: (paths: string[], scanId: string): Promise<string> => ipcRenderer.invoke(IPC.scanStart, paths, scanId),
    rescanFile: (path: string): Promise<RescanResult> => ipcRenderer.invoke(IPC.rescanFile, path),
    cancel: (scanId: string): Promise<boolean> => ipcRenderer.invoke(IPC.scanCancel, scanId),
    onProgress: (listener: (event: ScanProgressEvent) => void): Unsubscribe => {
      const handler = (_event: unknown, payload: ScanProgressEvent): void => listener(payload)
      ipcRenderer.on(IPC.scanProgress, handler)
      return () => ipcRenderer.removeListener(IPC.scanProgress, handler)
    },
    onComplete: (listener: (event: ScanCompleteEvent) => void): Unsubscribe => {
      const handler = (_event: unknown, payload: ScanCompleteEvent): void => listener(payload)
      ipcRenderer.on(IPC.scanComplete, handler)
      return () => ipcRenderer.removeListener(IPC.scanComplete, handler)
    }
  },
  jobs: {
    /** Leave `mode` out to use each file's own resolved mode. */
    enqueue: (requests: RepairRequest[], mode?: RepairMode): Promise<Job[]> =>
      ipcRenderer.invoke(IPC.jobsEnqueue, requests, mode),
    list: (): Promise<Job[]> => ipcRenderer.invoke(IPC.jobsList),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.jobsCancel, id),
    cancelAll: (): Promise<void> => ipcRenderer.invoke(IPC.jobsCancelAll),
    clearFinished: (): Promise<void> => ipcRenderer.invoke(IPC.jobsClear),
    /** Stop everything and empty the list. */
    clearAll: (): Promise<void> => ipcRenderer.invoke(IPC.jobsClearAll),
    onUpdate: (listener: (job: Job) => void): Unsubscribe => {
      const handler = (_event: unknown, payload: Job): void => listener(payload)
      ipcRenderer.on(IPC.jobUpdate, handler)
      return () => ipcRenderer.removeListener(IPC.jobUpdate, handler)
    }
  },
  shell: {
    reveal: (path: string): Promise<void> => ipcRenderer.invoke(IPC.revealPath, path),
    /** Pop up the native right-click menu for a file (reveal, copy path). */
    fileMenu: (path: string): Promise<void> => ipcRenderer.invoke(IPC.fileContextMenu, path)
  },
  app: {
    /** Paths the app was launched with (command line, Finder, Dock drop). */
    initialPaths: (): Promise<string[]> => ipcRenderer.invoke(IPC.initialPaths),
    /** The build and the runtime under it, for the About panel. */
    about: (): Promise<AboutInfo> => ipcRenderer.invoke(IPC.about),
    /** Write a report to a file the user picks; resolves to the path, or undefined if cancelled. */
    saveText: (suggestedName: string, contents: string): Promise<string | undefined> =>
      ipcRenderer.invoke(IPC.saveText, suggestedName, contents),
    /** The About menu item was chosen. */
    onShowAbout: (listener: () => void): Unsubscribe => {
      const handler = (): void => listener()
      ipcRenderer.on(IPC.showAbout, handler)
      return () => ipcRenderer.removeListener(IPC.showAbout, handler)
    },
    onOpenPaths: (listener: (paths: string[]) => void): Unsubscribe => {
      const handler = (_event: unknown, payload: string[]): void => listener(payload)
      ipcRenderer.on(IPC.openPaths, handler)
      return () => ipcRenderer.removeListener(IPC.openPaths, handler)
    }
  },
  /** Resolve the absolute path of a dropped File (Electron 32+ API). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('plexfixer', api)

export type PlexFixerApi = typeof api
