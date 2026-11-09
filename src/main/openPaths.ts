/**
 * Paths handed to the app from outside the window: command-line arguments,
 * macOS `open-file` events (Finder "Open With", dropping onto the Dock icon)
 * and a second launch while one instance is already running.
 *
 * Paths that arrive before a window exists are held here and collected by the
 * renderer when it starts.
 */

import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { app } from 'electron'

let queued: string[] = []
let deliver: ((paths: string[]) => void) | undefined

/** Electron and Chromium flags that would otherwise look like file paths. */
function isSwitch(argument: string): boolean {
  return argument.startsWith('-')
}

/** Keep only arguments that name something that actually exists on disk. */
export function filterExistingPaths(candidates: string[]): string[] {
  const paths: string[] = []
  for (const candidate of candidates) {
    if (!candidate || isSwitch(candidate)) continue
    const absolute = isAbsolute(candidate) ? candidate : resolve(candidate)
    try {
      statSync(absolute)
      paths.push(absolute)
    } catch {
      // Not a path — just another argument.
    }
  }
  return paths
}

/**
 * Extract media paths from an argv array.
 *
 * In a packaged build argv is `[exe, ...paths]`; running from source it is
 * `[electron, appDir, ...paths]`, so the app directory itself is skipped.
 */
export function pathsFromArgv(argv: string[]): string[] {
  const rest = argv.slice(app.isPackaged ? 1 : 2)
  const appPath = app.getAppPath()
  return filterExistingPaths(rest).filter((path) => path !== appPath)
}

export function queuePaths(paths: string[]): void {
  if (paths.length === 0) return
  if (deliver) deliver(paths)
  else queued = [...queued, ...paths]
}

/** Register the window's delivery callback and flush anything already queued. */
export function onPaths(callback: (paths: string[]) => void): void {
  deliver = callback
  if (queued.length > 0) {
    const pending = queued
    queued = []
    callback(pending)
  }
}

/** Paths that arrived before the renderer was ready. */
export function takeQueuedPaths(): string[] {
  const pending = queued
  queued = []
  return pending
}
