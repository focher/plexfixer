/**
 * The machine a scan or a repair actually runs on.
 *
 * Everything that touches files or runs a binary goes through a `Host`, so the
 * same scan and the same repair work whether the library is on this machine or
 * on the box that serves it. The remote implementation is `ssh` plus a handful
 * of POSIX utilities — no agent to install on the far end, and nothing to keep
 * in step with this app's version.
 *
 * Why run anything remotely at all: a remux copies every byte of the file. Over
 * a mounted share that is two network trips per byte, in and out again. Run it
 * where the disk is and it is one local copy.
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { open, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import { promisify } from 'node:util'
import type { AppSettings, VolumeInfo } from '@shared/types.js'
import { kindOfFilesystem, parseDf } from './volumes.js'
import { shellCommand, shellQuote, sshRun, sshSpawn, type SshTarget } from './remote/ssh.js'

const execFileAsync = promisify(execFile)

export interface HostEntry {
  name: string
  isDirectory: boolean
  sizeBytes?: number
}

export interface HostStat {
  sizeBytes: number
  modifiedMs?: number
  isDirectory: boolean
}

export interface ExecOptions {
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}

/** Path arithmetic, which is POSIX on the far end whatever this machine is. */
export interface HostPaths {
  join: (...parts: string[]) => string
  dirname: (value: string) => string
  basename: (value: string, ext?: string) => string
  extname: (value: string) => string
  relative: (from: string, to: string) => string
  isAbsolute: (value: string) => boolean
  sep: string
}

export interface Host {
  readonly kind: 'local' | 'remote'
  /** For messages: "this machine", or `user@host`. */
  readonly label: string
  readonly paths: HostPaths

  /** Run a binary and return its stdout; throws when it exits non-zero. */
  exec: (command: string, args: string[], options?: ExecOptions) => Promise<string>
  /** Start a binary, streaming stdout and stderr. */
  spawn: (command: string, args: string[]) => ChildProcessWithoutNullStreams
  /**
   * Stop a process started with `spawn`, identified by a string that appears
   * in its command line. Killing the local `ssh` does not reliably take the
   * remote process with it, so the remote host asks the far end directly.
   */
  kill: (marker: string) => Promise<void>

  stat: (path: string) => Promise<HostStat | undefined>
  list: (directory: string) => Promise<HostEntry[]>
  /** Bytes `[offset, offset + length)` of a file, for reading an MP4's boxes. */
  readRange: (path: string, offset: number, length: number) => Promise<Buffer>
  mkdirp: (path: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  remove: (path: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  volume: (path: string) => Promise<VolumeInfo>
  /** Every media file under these paths, as absolute paths. */
  findMedia: (roots: string[], extensions: string[], recursive: boolean) => Promise<string[]>
}

/* ------------------------------------------------------------------ *
 * Local
 * ------------------------------------------------------------------ */

const localPaths: HostPaths = {
  join: (...parts) => nodePath.join(...parts),
  dirname: (value) => nodePath.dirname(value),
  basename: (value, ext) => nodePath.basename(value, ext),
  extname: (value) => nodePath.extname(value),
  relative: (from, to) => nodePath.relative(from, to),
  isAbsolute: (value) => nodePath.isAbsolute(value),
  sep: nodePath.sep
}

export function localHost(): Host {
  return {
    kind: 'local',
    label: 'this machine',
    paths: localPaths,

    async exec(command, args, options) {
      const { stdout } = await execFileAsync(command, args, {
        maxBuffer: options?.maxBytes ?? 32 * 1024 * 1024,
        timeout: options?.timeoutMs ?? 120_000,
        signal: options?.signal,
        windowsHide: true
      })
      return stdout
    },

    spawn(command, args) {
      return spawn(command, args, { windowsHide: true })
    },

    async kill() {
      // Nothing to do: the child is ours, and the caller already signalled it.
    },

    async stat(path) {
      try {
        const info = await stat(path)
        return { sizeBytes: info.size, modifiedMs: info.mtimeMs, isDirectory: info.isDirectory() }
      } catch {
        return undefined
      }
    },

    async list(directory) {
      const entries = await readdir(directory, { withFileTypes: true })
      const out: HostEntry[] = []
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = nodePath.join(directory, entry.name)
        if (entry.isDirectory()) {
          out.push({ name: entry.name, isDirectory: true })
        } else if (entry.isFile()) {
          const info = await stat(full).catch(() => undefined)
          out.push({ name: entry.name, isDirectory: false, sizeBytes: info?.size })
        }
      }
      return out
    },

    async readRange(path, offset, length) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        return buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    },

    async mkdirp(path) {
      await mkdir(path, { recursive: true })
    },

    async rename(from, to) {
      await rename(from, to)
    },

    async remove(path) {
      await rm(path, { force: true })
    },

    async exists(path) {
      return (await stat(path).catch(() => undefined)) != null
    },

    async volume(path) {
      const { describeVolume } = await import('./volumes.js')
      return describeVolume(path)
    },

    async findMedia(roots, extensions, recursive) {
      const { collectMediaFiles } = await import('./scan/walk.js')
      return collectMediaFiles(roots, { extensions, recursive })
    }
  }
}

/* ------------------------------------------------------------------ *
 * Remote
 * ------------------------------------------------------------------ */

/** Directory names that never hold library media (and one of ours). */
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '@eaDir',
  '.AppleDouble',
  '.Trashes',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.plexfixer-backups'
])

const remotePaths: HostPaths = {
  join: (...parts) => nodePath.posix.join(...parts),
  dirname: (value) => nodePath.posix.dirname(value),
  basename: (value, ext) => nodePath.posix.basename(value, ext),
  extname: (value) => nodePath.posix.extname(value),
  relative: (from, to) => nodePath.posix.relative(from, to),
  isAbsolute: (value) => nodePath.posix.isAbsolute(value),
  sep: '/'
}

/**
 * `ls -lAnp` as entries.
 *
 * Numeric owner and group (`-n`) keeps the column count fixed — a user or
 * group name with a space in it would otherwise shift the filename — and `-p`
 * puts a slash on directories, which is the only type flag we need. Symlinks
 * are dropped, exactly as the local walker drops them.
 */
export function parseLsLong(output: string): HostEntry[] {
  const entries: HostEntry[] = []
  for (const line of output.split('\n')) {
    if (!line.trim() || line.startsWith('total ')) continue
    const fields = line.split(/\s+/)
    if (fields.length < 9) continue
    const perms = fields[0] ?? ''
    if (perms.startsWith('l')) continue
    const sizeBytes = Number(fields[4])
    // The name is everything after the eight fixed columns, spaces and all.
    let name = line.split(/\s+/).slice(8).join(' ')
    const arrow = name.indexOf(' -> ')
    if (arrow >= 0) name = name.slice(0, arrow)
    const isDirectory = perms.startsWith('d') || name.endsWith('/')
    if (isDirectory) name = name.replace(/\/$/, '')
    if (!name || name === '.' || name === '..') continue
    entries.push({ name, isDirectory, sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined })
  }
  return entries
}

/**
 * `stat` output from either coreutils or BSD.
 *
 * The two spell every format string differently, so both are attempted on the
 * far end and whichever answers wins; this parses the agreed shape they are
 * asked to print: size, mtime in seconds, and a type word.
 */
export function parseStatLine(output: string): HostStat | undefined {
  const line = output.trim().split('\n')[0]
  if (!line) return undefined
  const [size, mtime, ...rest] = line.split(/\s+/)
  const sizeBytes = Number(size)
  if (!Number.isFinite(sizeBytes)) return undefined
  const kind = rest.join(' ').toLowerCase()
  return {
    sizeBytes,
    modifiedMs: Number.isFinite(Number(mtime)) ? Number(mtime) * 1000 : undefined,
    isDirectory: kind.includes('directory')
  }
}

export function remoteHost(target: SshTarget): Host {
  const run = async (command: string, options?: ExecOptions): Promise<string> => {
    const result = await sshRun(target, command, {
      timeoutMs: options?.timeoutMs ?? 120_000,
      maxBytes: options?.maxBytes,
      signal: options?.signal
    })
    if (result.code !== 0) {
      const first = result.stderr.trim().split('\n')[0] ?? `exit code ${result.code}`
      throw new Error(first)
    }
    return result.stdout
  }

  return {
    kind: 'remote',
    label: target.host,
    paths: remotePaths,

    exec(command, args, options) {
      return run(shellCommand([command, ...args]), options)
    },

    spawn(command, args) {
      return sshSpawn(target, shellCommand([command, ...args]))
    },

    async kill(marker) {
      // `pkill -f` matches the whole command line, and the marker is the
      // temporary output path, which is unique to this job. A failure here is
      // reported by the job that asked, not thrown at it.
      await sshRun(target, shellCommand(['pkill', '-f', '--', marker]), { timeoutMs: 10_000 }).catch(() => undefined)
    },

    async stat(path) {
      try {
        const quoted = shellQuote(path)
        const output = await run(
          `stat -c '%s %Y %F' -- ${quoted} 2>/dev/null || stat -f '%z %m %HT' -- ${quoted}`,
          { timeoutMs: 20_000 }
        )
        return parseStatLine(output)
      } catch {
        return undefined
      }
    },

    async list(directory) {
      const output = await run(`ls -lAnp -- ${shellQuote(directory)}`, { timeoutMs: 60_000 })
      return parseLsLong(output)
    },

    async readRange(path, offset, length) {
      // `tail -c +N` counts from 1, and both halves of the pipe are POSIX.
      const output = await run(
        `tail -c +${offset + 1} -- ${shellQuote(path)} 2>/dev/null | head -c ${length} | base64`,
        { timeoutMs: 30_000 }
      )
      return Buffer.from(output.replace(/\s+/g, ''), 'base64')
    },

    async mkdirp(path) {
      await run(shellCommand(['mkdir', '-p', '--', path]), { timeoutMs: 20_000 })
    },

    async rename(from, to) {
      await run(shellCommand(['mv', '-f', '--', from, to]), { timeoutMs: 600_000 })
    },

    async remove(path) {
      await run(shellCommand(['rm', '-f', '--', path]), { timeoutMs: 60_000 })
    },

    async exists(path) {
      const result = await sshRun(target, shellCommand(['test', '-e', path]), { timeoutMs: 20_000 })
      return result.code === 0
    },

    async volume(path) {
      try {
        const output = await run(`df -P -- ${shellQuote(remotePaths.dirname(path))}`, { timeoutMs: 20_000 })
        const { filesystem, mount } = parseDf(output)
        return { filesystem, mount, kind: kindOfFilesystem(filesystem) }
      } catch {
        return { kind: 'unknown' }
      }
    },

    async findMedia(roots, extensions, recursive) {
      const wanted = new Set(extensions.map((ext) => ext.toLowerCase().replace(/^\./, '')))
      const found = new Set<string>()

      for (const root of roots) {
        const info = await this.stat(root)
        if (!info) continue
        if (!info.isDirectory) {
          if (wanted.has(remotePaths.extname(root).slice(1).toLowerCase())) found.add(root)
          continue
        }
        // `find` without -L, so symlinked directories are not followed — the
        // same rule the local walker follows, for the same reasons.
        const depth = recursive ? '' : ' -maxdepth 1'
        const output = await run(`find ${shellQuote(root)}${depth} -type f -print 2>/dev/null || true`, {
          timeoutMs: 600_000,
          maxBytes: 64 * 1024 * 1024
        })
        for (const line of output.split('\n')) {
          const path = line.trim()
          if (!path) continue
          const name = remotePaths.basename(path)
          if (name.startsWith('._')) continue
          if (!wanted.has(remotePaths.extname(path).slice(1).toLowerCase())) continue
          if (path.split('/').some((part) => SKIP_DIRECTORIES.has(part))) continue
          found.add(path)
        }
      }

      return [...found].sort((a, b) => a.localeCompare(b))
    }
  }
}

/* ------------------------------------------------------------------ *
 * Choosing one
 * ------------------------------------------------------------------ */

export function remoteTargetFor(settings: AppSettings): SshTarget | undefined {
  if (!settings.remoteEnabled || !settings.remoteHost.trim()) return undefined
  return { host: settings.remoteHost.trim(), port: settings.remotePort > 0 ? settings.remotePort : undefined }
}

/** The host every scan and repair should use, given the settings in force. */
export function hostFor(settings: AppSettings): Host {
  const target = remoteTargetFor(settings)
  return target ? remoteHost(target) : localHost()
}
