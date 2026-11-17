/**
 * The machine across an SSH connection, as a host like any other.
 *
 * Every operation is a command run on the far end through the *local* host,
 * which is the only thing here that differs between shells — and it is passed
 * in. A remux that would otherwise copy every byte twice across the network
 * instead runs where the disk is.
 *
 * The parsers are separate and exported because `ls -l` and `stat` are the
 * only way to ask a POSIX machine about a file without installing anything on
 * it, and their output is quietly different between BSD and GNU.
 */

import type { AppSettings } from '../types.js'
import type { ExecOptions, HostEntry, HostStat, RepairHost } from '../host.js'
import { pathsFor } from '../paths.js'
import { kindOfFilesystem, parseDf } from './volumes.js'
import { literalPattern, shellCommand, shellQuote, sshRun, sshSpawn, type SshTarget } from './ssh.js'

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

/** The far end is POSIX whatever this machine is. */
const remotePaths = pathsFor('linux')

/**
 * `ls -lAnp` as entries.
 *
 * Numeric owner and group (`-n`) keeps the column count fixed — a user or
 * group name with a space in it would otherwise shift the filename — and `-p`
 * puts a slash on directories, which is the only type flag we need. Symlinks
 * are dropped: the remote scan uses `find` without `-L`, so it does not follow
 * them either, and a browser that offered one would offer a folder the scan
 * then finds nothing in.
 *
 * The name is taken as the rest of the line after the eight fixed columns,
 * exactly as written. Splitting the whole line on whitespace and joining it
 * back with single spaces turned `Two  Spaces.mkv` into a name that does not
 * exist.
 */
export function parseLsLong(output: string): HostEntry[] {
  const entries: HostEntry[] = []
  for (const line of output.split('\n')) {
    if (!line.trim() || line.startsWith('total ')) continue
    // Eight columns, each followed by padding, then one separator and the name.
    const columns = /^((?:\S+\s+){7}\S+)\s(.*)$/.exec(line)
    if (!columns) continue
    const fields = columns[1]!.split(/\s+/)
    const perms = fields[0] ?? ''
    if (perms.startsWith('l')) continue
    const sizeBytes = Number(fields[4])
    let name = columns[2]!
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

export function remoteHost(target: SshTarget, local: RepairHost): RepairHost {
  const run = async (command: string, options?: ExecOptions): Promise<string> => {
    const result = await sshRun(local, target, command, {
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

  // Named, and referred to by name below rather than through `this`. A host is
  // an object of functions, and callers take those functions off it — the Tauri
  // shell hands `host.findMedia` straight to the scan — at which point `this`
  // is undefined and the call fails on the first thing it reaches for.
  const host: RepairHost = {
    kind: 'remote',
    label: target.host,
    paths: remotePaths,

    exec(command, args, options) {
      return run(shellCommand([command, ...args]), options)
    },

    spawnProcess(command, args) {
      return sshSpawn(local, target, shellCommand([command, ...args]))
    },

    async writeRange() {
      // In-place header edits are local-only by design: the gain is skipping a
      // copy, and there is no copy to skip when the bytes are already there.
      throw new Error('Editing a file in place is only done on the machine that holds it.')
    },

    async kill(marker) {
      // `pkill -f` matches the whole command line, and the marker is the
      // temporary output path, which is unique to this job. A failure here is
      // reported by the job that asked, not thrown at it.
      await sshRun(local, target, shellCommand(['pkill', '-f', '--', literalPattern(marker)]), {
        timeoutMs: 10_000
      }).catch(() => undefined)
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
      // `atob` rather than `Buffer`: this runs in a webview too.
      const binary = atob(output.replace(/\s+/g, ''))
      return Uint8Array.from(binary, (character) => character.charCodeAt(0))
    },

    async mkdirp(path) {
      await run(shellCommand(['mkdir', '-p', '--', path]), { timeoutMs: 20_000 })
    },

    async rename(from, to) {
      await run(shellCommand(['mv', '-f', '--', from, to]), { timeoutMs: 600_000 })
    },

    async cloneFile() {
      // In-place edits never run remotely, so there is nothing to back up here.
      return false
    },

    async remove(path) {
      await run(shellCommand(['rm', '-f', '--', path]), { timeoutMs: 60_000 })
    },

    async removeEmptyDirectory(path) {
      await run(shellCommand(['rmdir', '--', path]), { timeoutMs: 20_000 })
    },

    async exists(path) {
      const result = await sshRun(local, target, shellCommand(['test', '-e', path]), { timeoutMs: 20_000 })
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
        const info = await host.stat(root)
        if (!info) continue
        if (!info.isDirectory) {
          if (wanted.has(remotePaths.extname(root).slice(1).toLowerCase())) found.add(root)
          continue
        }
        // `find` without -L, so symlinked directories are not followed. The
        // local walker does follow them now, remembering where it has been;
        // doing the same here means deduplicating what `find -L` reports
        // twice, which nobody has needed yet.
        const depth = recursive ? '' : ' -maxdepth 1'
        const output = await run(`find ${shellQuote(root)}${depth} -type f -print 2>/dev/null || true`, {
          timeoutMs: 600_000,
          maxBytes: 64 * 1024 * 1024
        })
        // Everything `find` prints begins with the folder it was given. A line
        // that does not is the tail of a file name with a newline in it — and
        // a name is chosen by whoever made the file, so `x\n/etc/other.mkv`
        // would otherwise put a path of their choosing on the list of files
        // to repair.
        const within = root.endsWith('/') ? root : `${root}/`
        for (const path of output.split('\n')) {
          // Not trimmed: a name may begin or end with a space, and a path with
          // one taken off is a path to nothing.
          if (!path || !path.startsWith(within)) continue
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

  return host
}

/* ------------------------------------------------------------------ *
 * Choosing one
 * ------------------------------------------------------------------ */

export function remoteTargetFor(settings: AppSettings): SshTarget | undefined {
  if (!settings.remoteEnabled || !settings.remoteHost.trim()) return undefined
  return {
    host: settings.remoteHost.trim(),
    port: settings.remotePort > 0 ? settings.remotePort : undefined,
    identityFile: settings.remoteKeyPath.trim() || undefined
  }
}
