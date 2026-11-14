/**
 * Path arithmetic for a host that is not necessarily this machine.
 *
 * Node's `path` module answers for the platform it is running on, which is the
 * wrong answer twice over: when the files are on a Linux box reached over SSH,
 * and when the code is running in a webview with no `path` module at all. This
 * is the same handful of operations, told which separator to use.
 *
 * It is deliberately small. Only what probing and repairing actually ask for
 * is here, and nothing normalises `..` or resolves anything — these paths come
 * from a filesystem that just listed them, not from user input.
 */

import type { HostPaths } from './host.js'

function build(sep: '/' | '\\'): HostPaths {
  const isWindows = sep === '\\'
  /** Both separators count on Windows: plenty of tools hand back forward slashes. */
  const splitOn = isWindows ? /[\\/]/ : /\//

  const isAbsolute = (value: string): boolean =>
    isWindows ? /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') : value.startsWith('/')

  const join = (...parts: string[]): string => {
    const kept = parts.filter((part) => part.length > 0)
    if (kept.length === 0) return '.'
    const joined = kept
      .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
      .filter((part, index) => index === 0 || part.length > 0)
      .join(sep)
    // A root of its own ("/" or "C:\") loses its separator above; put it back.
    return joined === '' && isAbsolute(kept[0]) ? kept[0] : joined
  }

  const basename = (value: string, ext?: string): string => {
    const parts = value.split(splitOn).filter((part) => part.length > 0)
    const last = parts.at(-1) ?? ''
    return ext && last.endsWith(ext) && last !== ext ? last.slice(0, -ext.length) : last
  }

  const dirname = (value: string): string => {
    const trimmed = value.replace(/[\\/]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('/'), isWindows ? trimmed.lastIndexOf('\\') : -1)
    if (index < 0) return '.'
    if (index === 0) return sep
    return trimmed.slice(0, index)
  }

  const extname = (value: string): string => {
    const name = basename(value)
    const index = name.lastIndexOf('.')
    // A leading dot is a hidden file, not an extension.
    return index > 0 ? name.slice(index) : ''
  }

  const relative = (from: string, to: string): string => {
    const split = (value: string): string[] => value.split(splitOn).filter((part) => part.length > 0)
    const fromParts = split(from)
    const toParts = split(to)
    let shared = 0
    while (shared < fromParts.length && shared < toParts.length) {
      const a = isWindows ? fromParts[shared].toLowerCase() : fromParts[shared]
      const b = isWindows ? toParts[shared].toLowerCase() : toParts[shared]
      if (a !== b) break
      shared++
    }
    const up = Array.from({ length: fromParts.length - shared }, () => '..')
    return [...up, ...toParts.slice(shared)].join(sep)
  }

  return { join, dirname, basename, extname, relative, isAbsolute, sep }
}

export const posixPaths: HostPaths = build('/')
export const windowsPaths: HostPaths = build('\\')

/** The conventions of a host, told which platform it is. */
export function pathsFor(platform: string): HostPaths {
  return platform === 'win32' || platform === 'windows' ? windowsPaths : posixPaths
}
