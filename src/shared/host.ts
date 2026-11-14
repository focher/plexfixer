import type { VolumeInfo } from './types.js'

/**
 * The machine a file lives on, as far as reading it is concerned.
 *
 * Everything that inspects media — probing, box walking, sidecar discovery —
 * is written against this rather than against `node:fs`, which is what lets
 * the same code run over SSH as over a local disk. It is also the seam the
 * Tauri shell uses: there, these calls land in Rust instead of Node, and the
 * code above them neither knows nor cares.
 *
 * The write side (spawning, renaming, cloning, removing) stays in each shell's
 * own `Host`, which extends this. Only the read side is needed to decide what
 * is wrong with a file, and only the read side is portable without dragging a
 * platform's process types along with it.
 */

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

/** Path arithmetic for the host's own conventions, not this machine's. */
export interface HostPaths {
  join: (...parts: string[]) => string
  dirname: (value: string) => string
  basename: (value: string, ext?: string) => string
  extname: (value: string) => string
  relative: (from: string, to: string) => string
  isAbsolute: (value: string) => boolean
  sep: string
}

export interface ExecOptions {
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
  /**
   * Written to the command's stdin and then closed.
   *
   * `ssh-keygen -lf -` reads a host key this way, which is how a key's
   * fingerprint is worked out without writing it to disk first.
   */
  input?: string
}

/**
 * A process that is running somewhere — here, or on the far end of an SSH
 * connection, or behind a Tauri command.
 *
 * Deliberately not Node's `ChildProcess`: the only things a repair needs from
 * a running ffmpeg are its two output streams, its exit, and a way to ask it
 * to stop, and those exist everywhere. Carrying the Node type instead would
 * have pinned the repair runner to one runtime for the sake of methods it
 * never calls.
 */
export interface HostProcess {
  /** UTF-8 chunks of stdout as they arrive. */
  onStdout: (listener: (chunk: string) => void) => void
  onStderr: (listener: (chunk: string) => void) => void
  /**
   * Resolves when the process ends, however it ended, and rejects only when it
   * could not be started at all.
   */
  closed: Promise<{ code: number | null; signalName?: string }>
  /**
   * Ask it to stop — SIGTERM, not SIGKILL, so ffmpeg finalises and closes its
   * output file rather than leaving a stub behind.
   */
  terminate: () => void
}

export interface ProbeHost {
  readonly kind: 'local' | 'remote'
  /** For messages: "this machine", or `user@host`. */
  readonly label: string
  readonly paths: HostPaths

  /** Run a binary and return its stdout; throws when it exits non-zero. */
  exec: (command: string, args: string[], options?: ExecOptions) => Promise<string>
  stat: (path: string) => Promise<HostStat | undefined>
  list: (directory: string) => Promise<HostEntry[]>
  /** Bytes `[offset, offset + length)` of a file, for reading an MP4's boxes. */
  readRange: (path: string, offset: number, length: number) => Promise<Uint8Array>
}

/**
 * The rest of what a repair needs: writing, moving and removing files, and
 * starting a long-running process it can watch and stop.
 */
export interface RepairHost extends ProbeHost {
  /** Start a binary, streaming its output. */
  spawnProcess: (command: string, args: string[]) => HostProcess
  /**
   * Stop a process started with `spawnProcess`, identified by a string that
   * appears in its command line. Killing the local `ssh` does not reliably
   * take the remote process with it, so a remote host asks the far end.
   */
  kill: (marker: string) => Promise<void>

  /**
   * Overwrite the bytes at `offset`, durably, leaving the rest of the file
   * alone. This is how an MP4 header is corrected without rewriting a
   * forty-gigabyte file; it is only ever done where the file actually is.
   */
  writeRange: (path: string, offset: number, bytes: Uint8Array) => Promise<void>
  mkdirp: (path: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  /**
   * An instant copy sharing the original's data (an APFS clone), for a backup
   * that costs no time and almost no space. Resolves false, having written
   * nothing, wherever that is not possible: a real copy of a multi-gigabyte
   * file is exactly what this exists to avoid.
   */
  cloneFile: (from: string, to: string) => Promise<boolean>
  remove: (path: string) => Promise<void>
  /** Remove a directory only if it is empty; a folder with anything left stays. */
  removeEmptyDirectory: (path: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  volume: (path: string) => Promise<VolumeInfo>
  /** Every media file under these paths, as absolute paths. */
  findMedia: (roots: string[], extensions: string[], recursive: boolean) => Promise<string[]>
}
