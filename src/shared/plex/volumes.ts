/**
 * Reading what a path is sitting on.
 *
 * Both shells get the same raw answers — a device id and the output of `df` —
 * and parse them here, where the parsing is tested. Only how those answers are
 * obtained differs between them.
 */

import type { VolumeInfo } from '../types.js'

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
