/**
 * Which volume a path lives on, and whether that volume is across a network.
 *
 * This exists for one question: when a repair takes longer than it should, was
 * the file being read over a network mount, and did the finished file have to
 * cross volumes to reach its destination? Both are invisible from the path and
 * both cost minutes on a large file.
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { parse } from 'node:path'
import { promisify } from 'node:util'
import type { VolumeInfo } from '@shared/types.js'

const execFileAsync = promisify(execFile)

/** One lookup per directory per run: mounts do not move underneath us. */
const cache = new Map<string, VolumeInfo>()

/**
 * A filesystem that is not a local device.
 *
 * SMB mounts appear as `//user@host/share`, NFS as `host:/export`, and macOS
 * reports some as `afpfs`/`smbfs`. Anything that names a host is remote; a
 * device node under /dev is not.
 */
export function kindOfFilesystem(filesystem: string | undefined): VolumeInfo['kind'] {
  if (!filesystem) return 'unknown'
  if (filesystem.startsWith('//') || filesystem.startsWith('\\\\')) return 'network'
  if (/^[A-Za-z][\w.-]*:\//.test(filesystem)) return 'network'
  if (/^(smbfs|afpfs|nfs|cifs|webdav|ftp)/i.test(filesystem)) return 'network'
  if (filesystem.startsWith('/dev/')) return 'local'
  return 'unknown'
}

/**
 * Filesystem types by mount point, from macOS `mount`, whose lines read
 * `/dev/disk15s1 on /Volumes/Video10e (apfs, local, nodev, …)`.
 */
export function parseMountTypes(output: string): Map<string, string> {
  const types = new Map<string, string>()
  for (const line of output.split('\n')) {
    const match = /^.+? on (.+) \(([^,)]+)/.exec(line.trim())
    if (match) types.set(match[1], match[2].trim().toLowerCase())
  }
  return types
}

let mountTypes: Promise<Map<string, string>> | undefined

/** The filesystem type of a mount point; macOS only, looked up once per run. */
async function filesystemType(mount: string | undefined): Promise<string | undefined> {
  if (!mount || process.platform !== 'darwin') return undefined
  mountTypes ??= execFileAsync('/sbin/mount', [], { timeout: 4000 })
    .then(({ stdout }) => parseMountTypes(stdout))
    .catch(() => new Map<string, string>())
  const types = await mountTypes
  // A volume mounted after the first lookup is not in the cached table yet.
  if (!types.has(mount)) {
    mountTypes = undefined
    return undefined
  }
  return types.get(mount)
}

/**
 * Parse `df -P`, whose output is two lines: a header and the filesystem the
 * path is on. The mount point is the last field and the device the first;
 * everything between is sizes, which vary by platform and are not wanted here.
 */
export function parseDf(output: string): { filesystem?: string; mount?: string } {
  const lines = output.trim().split('\n')
  const row = lines[lines.length - 1]
  if (!row || lines.length < 2) return {}
  const fields = row.trim().split(/\s+/)
  if (fields.length < 2) return {}
  // The mount point may contain spaces ("/Volumes/My Disk"), so it is
  // everything after the five numeric columns rather than the last field.
  const mount = fields.slice(5).join(' ') || fields[fields.length - 1]
  return { filesystem: fields[0], mount }
}

export async function describeVolume(path: string): Promise<VolumeInfo> {
  const directory = parse(path).dir || path
  const cached = cache.get(directory)
  if (cached) return cached

  let device: number | undefined
  try {
    device = (await stat(directory)).dev
  } catch {
    /* the directory may not exist yet; the rest is still worth reporting */
  }

  let info: VolumeInfo = { kind: 'unknown', device }

  if (process.platform === 'win32') {
    // A UNC path is a share by definition; anything else is the drive it names.
    const unc = directory.startsWith('\\\\')
    info = { ...info, kind: unc ? 'network' : 'local', mount: unc ? directory.split('\\').slice(0, 4).join('\\') : parse(directory).root }
  } else {
    try {
      const { stdout } = await execFileAsync('df', ['-P', directory], { timeout: 4000 })
      const { filesystem, mount } = parseDf(stdout)
      info = { ...info, filesystem, mount, kind: kindOfFilesystem(filesystem), type: await filesystemType(mount) }
    } catch {
      /* df is missing or refused: the device id alone still answers "same volume?" */
    }
  }

  cache.set(directory, info)
  return info
}
