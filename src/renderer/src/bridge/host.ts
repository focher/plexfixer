/**
 * A `RepairHost` whose filesystem and processes are on the other side of
 * `invoke`.
 *
 * Everything that reads or repairs a media file is written against this
 * interface, so handing it this makes the whole of `@shared/plex` work in a
 * webview without a line of it changing. The Electron build hands the same
 * code a host backed by `node:fs`, and the remote one a host backed by SSH.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { HostEntry, HostProcess, HostStat, RepairHost, ExecOptions } from '@shared/host.js'
import type { HostKeyTools } from '@shared/plex/hostkey.js'
import { newId } from '@shared/ids.js'
import { pathsFor } from '@shared/paths.js'
import { kindOfFilesystem, parseDf } from '@shared/plex/volumes.js'
import type { VolumeInfo } from '@shared/types.js'

interface BinaryPaths {
  /** Paths from Settings; Rust only runs binaries it resolved or these. */
  ffmpeg?: string
  ffprobe?: string
}

interface OutputEvent {
  id: string
  stream: 'stdout' | 'stderr'
  text: string
}

interface EndedEvent {
  id: string
  code: number | null
  signalName?: string
}

interface VolumeFacts {
  device?: number
  df?: string
  fsType?: string
}

/**
 * One subscription each, shared by every running process.
 *
 * Tauri's `listen` is asynchronous, so a per-process subscription would race
 * the first chunk of output — which for a repair is the first progress block,
 * and losing it means a job that looks stuck until the second one arrives.
 * Subscribing once at startup and routing by id has no such window.
 */
const outputListeners = new Map<string, (event: OutputEvent) => void>()
const endedListeners = new Map<string, (event: EndedEvent) => void>()

let routing: Promise<void> | undefined
function startRouting(): Promise<void> {
  routing ??= Promise.all([
    listen<OutputEvent>('plexfixer://process-output', (message) =>
      outputListeners.get(message.payload.id)?.(message.payload)
    ),
    listen<EndedEvent>('plexfixer://process-ended', (message) =>
      endedListeners.get(message.payload.id)?.(message.payload)
    )
  ]).then(() => undefined)
  return routing
}

export function tauriHost(platform: string, binaries: BinaryPaths = {}): RepairHost {
  const settingsFfmpeg = binaries.ffmpeg || null
  const settingsFfprobe = binaries.ffprobe || null

  return {
    kind: 'local',
    label: 'this machine',
    paths: pathsFor(platform),

    exec: (command: string, args: string[], options?: ExecOptions): Promise<string> =>
      invoke('host_exec', {
        command,
        args,
        timeoutMs: options?.timeoutMs ?? null,
        settingsFfmpeg,
        settingsFfprobe
      }),

    stat: (path: string): Promise<HostStat | undefined> =>
      invoke<HostStat | null>('host_stat', { path }).then((value) => value ?? undefined),

    list: (directory: string): Promise<HostEntry[]> => invoke('host_list', { directory }),

    readRange: async (path: string, offset: number, length: number): Promise<Uint8Array> =>
      // Tauri hands a byte array back as numbers; the box walk reads sixteen
      // bytes at a time, so there is nothing here worth a faster encoding.
      Uint8Array.from(await invoke<number[]>('host_read_range', { path, offset, length })),

    writeRange: (path: string, offset: number, bytes: Uint8Array): Promise<void> =>
      invoke('host_write_range', { path, offset, bytes: [...bytes] }),

    mkdirp: (path: string): Promise<void> => invoke('host_mkdirp', { path }),
    rename: (from: string, to: string): Promise<void> => invoke('host_rename', { from, to }),
    cloneFile: (from: string, to: string): Promise<boolean> => invoke('host_clone_file', { from, to }),
    remove: (path: string): Promise<void> => invoke('host_remove', { path }),
    removeEmptyDirectory: (path: string): Promise<void> => invoke('host_remove_empty_directory', { path }),
    exists: (path: string): Promise<boolean> => invoke('host_exists', { path }),

    async volume(path: string): Promise<VolumeInfo> {
      const facts = await invoke<VolumeFacts>('host_volume', { path })
      const { filesystem, mount } = facts.df ? parseDf(facts.df) : {}
      return {
        device: facts.device,
        filesystem,
        mount,
        kind: kindOfFilesystem(filesystem),
        type: facts.fsType
      }
    },

    findMedia: (roots: string[], extensions: string[], recursive: boolean): Promise<string[]> =>
      invoke('find_media', { roots, extensions, recursive }),

    spawnProcess(command: string, args: string[]): HostProcess {
      const id = newId()
      const stdout: ((chunk: string) => void)[] = []
      const stderr: ((chunk: string) => void)[] = []

      outputListeners.set(id, (event) => {
        for (const listener of event.stream === 'stdout' ? stdout : stderr) listener(event.text)
      })

      const closed = new Promise<{ code: number | null; signalName?: string }>((resolve, reject) => {
        endedListeners.set(id, (event) => {
          outputListeners.delete(id)
          endedListeners.delete(id)
          resolve({ code: event.code, signalName: event.signalName })
        })

        void startRouting()
          .then(() =>
            invoke('process_start', { id, command, args, settingsFfmpeg, settingsFfprobe })
          )
          .catch((error: unknown) => {
            outputListeners.delete(id)
            endedListeners.delete(id)
            reject(error instanceof Error ? error : new Error(String(error)))
          })
      })

      return {
        onStdout: (listener) => stdout.push(listener),
        onStderr: (listener) => stderr.push(listener),
        closed,
        terminate: () => void invoke('process_terminate', { id })
      }
    },

    kill: (marker: string): Promise<void> => invoke('process_kill_matching', { marker })
  }
}

/**
 * What the host-key code needs: ssh and friends, and `known_hosts`.
 *
 * The file is reached by name through Rust rather than by a path from here,
 * so this cannot become a way to append to anything else.
 */
export function hostKeyTools(local: RepairHost): HostKeyTools {
  return {
    exec: (command, args, options) => local.exec(command, args, options),
    knownHosts: {
      read: () => invoke('known_hosts_read'),
      append: (lines) => invoke('known_hosts_append', { line: lines }),
      location: () => invoke('known_hosts_location')
    }
  }
}
