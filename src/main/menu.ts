/**
 * The application menu.
 *
 * Electron's stock menu is kept almost verbatim — the one reason to build our
 * own is About: the native panel can show a name, a version and a line of
 * copyright and nothing else, and the version details that actually answer a
 * bug report (which ffmpeg, from where, on what) live in the renderer. So the
 * menu item opens the app's own panel instead.
 */

import { BrowserWindow, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/ipc.js'
import { PRODUCT_NAME, RELEASES_URL } from '@shared/about.js'

function showAbout(): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (window && !window.isDestroyed()) {
    window.show()
    window.webContents.send(IPC.showAbout)
  }
}

export function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const about: MenuItemConstructorOptions = { label: `About ${PRODUCT_NAME}`, click: () => showAbout() }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: PRODUCT_NAME,
            submenu: [
              about,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { label: '&File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '&Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Releases', click: () => void shell.openExternal(RELEASES_URL) },
        // On macOS About lives in the app menu, where the platform puts it.
        ...(isMac ? [] : ([{ type: 'separator' }, about] satisfies MenuItemConstructorOptions[]))
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
