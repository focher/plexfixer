import type { HostEntry, HostPaths, HostProcess, RepairHost } from '../src/shared/host.js'
export type { ExecOptions, HostEntry, HostPaths, HostProcess, HostStat, ProbeHost, RepairHost } from '../src/shared/host.js'

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
import { open, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import { promisify } from 'node:util'
import type { AppSettings } from '../src/shared/types.js'
import { remoteHost, remoteTargetFor } from '../src/shared/plex/remote-host.js'

export { remoteHost, remoteTargetFor } from '../src/shared/plex/remote-host.js'
export type { SshTarget } from '../src/shared/plex/ssh.js'

const execFileAsync = promisify(execFile)




/** Path arithmetic, which is POSIX on the far end whatever this machine is. */

/**
 * A `RepairHost` backed by Node, for the tests.
 *
 * The app itself reaches the filesystem through Rust; this is the same
 * interface over `node:fs` and `node:child_process`, so the suite can run the
 * real repair code against real files — which is where the confidence in
 * `src/shared` actually comes from.
 *
 * This machine, or a machine reached over SSH.
 *
 * Everything a repair needs is `RepairHost`, which is shared with the shell
 * that does not run Node. There is nothing left for the Electron build to add
 * on top, which is the point: the two shells meet at exactly this interface.
 */
export type Host = RepairHost

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

/**
 * A Node child process seen as a `HostProcess`.
 *
 * The repair runner is written against the smaller interface so it can run in
 * a webview as well as here; this is the ten lines that make Node's version
 * fit it.
 */
function nodeProcess(child: ChildProcessWithoutNullStreams): HostProcess {
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  return {
    onStdout: (listener) => child.stdout.on('data', (chunk: string) => listener(chunk)),
    onStderr: (listener) => child.stderr.on('data', (chunk: string) => listener(chunk)),
    closed: new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code, signalName) => resolve({ code, signalName: signalName ?? undefined }))
    }),
    terminate: () => child.kill('SIGTERM')
  }
}

export function localHost(): Host {
  return {
    kind: 'local',
    label: 'this machine',
    paths: localPaths,

    async exec(command, args, options) {
      const settings = {
        maxBuffer: options?.maxBytes ?? 32 * 1024 * 1024,
        timeout: options?.timeoutMs ?? 120_000,
        signal: options?.signal,
        windowsHide: true as const
      }
      if (options?.input == null) {
        const { stdout } = await execFileAsync(command, args, settings)
        return stdout
      }
      // `execFile` cannot write to stdin, and `ssh-keygen -lf -` wants the key
      // there rather than in a file.
      const child = execFile(command, args, settings)
      let stdout = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      const finished = new Promise<void>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))))
      })
      child.stdin?.end(options.input)
      await finished
      return stdout
    },

    spawnProcess(command, args) {
      return nodeProcess(spawn(command, args, { windowsHide: true }))
    },

    async writeRange(path, offset, bytes) {
      const handle = await open(path, 'r+')
      try {
        await handle.write(bytes, 0, bytes.length, offset)
        // The caller is about to verify what it wrote; an unflushed write
        // would be verified out of the page cache and tell it nothing.
        await handle.sync()
      } finally {
        await handle.close()
      }
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

    async cloneFile(from, to) {
      // Node's COPYFILE_FICLONE_FORCE is not implemented on macOS, and `cp -c`
      // quietly falls back to a full copy when it cannot clone. So the clone
      // is only attempted where it is certain to work: both ends on the same
      // APFS volume — which a backup folder beside its file always is.
      if (process.platform !== 'darwin') return false
      const { describeVolume } = await import('./node-volumes.js')
      const [source, target] = await Promise.all([describeVolume(from), describeVolume(to)])
      if (source.type !== 'apfs' || source.device == null || source.device !== target.device) return false
      await execFileAsync('/bin/cp', ['-c', '-p', from, to], { timeout: 60_000 })
      return true
    },

    async remove(path) {
      await rm(path, { force: true })
    },

    async removeEmptyDirectory(path) {
      await rmdir(path)
    },

    async exists(path) {
      return (await stat(path).catch(() => undefined)) != null
    },

    async volume(path) {
      const { describeVolume } = await import('./node-volumes.js')
      return describeVolume(path)
    },

    async findMedia(roots, extensions, recursive) {
      const { collectMediaFiles } = await import('./node-walk.js')
      return collectMediaFiles(roots, { extensions, recursive })
    }
  }
}

/* ------------------------------------------------------------------ *
 * Remote
 * ------------------------------------------------------------------ */


/** The host every scan and repair should use, given the settings in force. */
export function hostFor(settings: AppSettings): Host {
  const target = remoteTargetFor(settings)
  return target ? remoteHost(target, localHost()) : localHost()
}
