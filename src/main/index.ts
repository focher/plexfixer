import { join } from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import { registerIpcHandlers } from './ipc.js'
import { IPC } from '@shared/ipc.js'
import { filterExistingPaths, onPaths, pathsFromArgv, queuePaths } from './openPaths.js'

const isDevelopment = !app.isPackaged

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: 'PlexFixer',
    backgroundColor: '#14161c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // The renderer never touches Node or the filesystem directly; everything
      // goes through the narrow IPC surface in `ipc.ts`.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.once('ready-to-show', () => window.show())

  // Once the renderer is live, paths from the command line or Finder are
  // forwarded straight to it; anything that arrived earlier is flushed now.
  window.webContents.once('did-finish-load', () => {
    onPaths((paths) => {
      if (!window.isDestroyed()) window.webContents.send(IPC.openPaths, paths)
    })
  })

  // External links open in the user's browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDevelopment && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return window
}

// A second instance should focus the existing window rather than opening a new
// one — two instances writing the same settings file would fight.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
    // "plexfixer /some/folder" while already running should scan that folder.
    queuePaths(filterExistingPaths(argv.slice(1)))
  })

  // macOS delivers Finder "Open With" and Dock drops this way, sometimes
  // before `whenReady` resolves — hence the queue.
  app.on('open-file', (event, path) => {
    event.preventDefault()
    queuePaths(filterExistingPaths([path]))
  })

  void app.whenReady().then(() => {
    registerIpcHandlers()
    queuePaths(pathsFromArgv(process.argv))
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
