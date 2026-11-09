/**
 * Locating the ffmpeg and ffprobe binaries.
 *
 * Packaged builds ship static binaries under `resources/bin/<platform>-<arch>/`.
 * In development the same folder is used if populated (`npm run fetch:ffmpeg`),
 * otherwise PATH is searched so a Homebrew/winget install works out of the box.
 * A user-supplied path in Settings always wins.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type BinaryName = 'ffmpeg' | 'ffprobe'

function exeName(name: BinaryName): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

/** `resources/bin/<platform>-<arch>` inside the app bundle or the repo. */
function bundledDir(): string {
  const platformDir = `${process.platform}-${process.arch}`
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, app.isPackaged ? 'bin' : 'resources/bin', platformDir)
}

/** Search PATH for a binary without shelling out to `which`/`where`. */
function searchPath(name: BinaryName): string | undefined {
  const pathVar = process.env.PATH ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  // Electron on macOS inherits a minimal PATH when launched from Finder, so the
  // usual install locations are checked explicitly.
  const extra =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
      : process.platform === 'linux'
        ? ['/usr/bin', '/usr/local/bin', '/snap/bin']
        : []
  for (const dir of [...pathVar.split(separator), ...extra]) {
    if (!dir) continue
    const candidate = join(dir, exeName(name))
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export interface BinaryLocation {
  path: string
  source: 'settings' | 'bundled' | 'path'
}

/**
 * Resolve a binary, preferring an explicit override, then the bundled copy,
 * then PATH. Returns `undefined` when nothing usable is found.
 */
export function locateBinary(name: BinaryName, override?: string): BinaryLocation | undefined {
  if (override && existsSync(override)) return { path: override, source: 'settings' }

  const bundled = join(bundledDir(), exeName(name))
  if (existsSync(bundled)) return { path: bundled, source: 'bundled' }

  const onPath = searchPath(name)
  if (onPath) return { path: onPath, source: 'path' }

  return undefined
}

export class BinaryMissingError extends Error {
  constructor(name: BinaryName) {
    super(
      `Could not find ${name}. Install FFmpeg and point Settings → Advanced at it, or run ` +
        '"npm run fetch:ffmpeg" to download the bundled binaries.'
    )
    this.name = 'BinaryMissingError'
  }
}

export function requireBinary(name: BinaryName, override?: string): string {
  const located = locateBinary(name, override)
  if (!located) throw new BinaryMissingError(name)
  return located.path
}

/** Read the version banner, used to confirm a located binary actually runs. */
export async function binaryVersion(binaryPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['-version'], { maxBuffer: 1024 * 1024 })
    return stdout.split('\n', 1)[0]?.trim()
  } catch {
    return undefined
  }
}
