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
import type { VolumeInfo } from '../src/shared/types.js'
import { kindOfFilesystem, parseDf } from '../src/shared/plex/volumes.js'

export { kindOfFilesystem, parseDf } from '../src/shared/plex/volumes.js'

const execFileAsync = promisify(execFile)

/** One lookup per directory per run: mounts do not move underneath us. */
const cache = new Map<string, VolumeInfo>()


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
