/**
 * Pure helpers for the renderer's stored library: which stored files a scan
 * shows to be gone, and what the search box matches.
 */

/** Whether `path` is `root` itself or somewhere beneath it. */
export function isWithin(path: string, root: string): boolean {
  if (path === root) return true
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`
  return path.startsWith(prefix)
}

/**
 * The paths a finished scan shows to be gone: stored under one of the scanned
 * folders (or equal to a scanned file) but no longer found by the walk.
 *
 * A cancelled scan proves nothing about the files it did not reach, so it
 * removes nothing.
 */
export function stalePaths(
  stored: Iterable<string>,
  inputPaths: string[],
  foundPaths: string[],
  cancelled: boolean
): string[] {
  if (cancelled) return []
  const found = new Set(foundPaths)
  const stale: string[] = []
  for (const path of stored) {
    if (found.has(path)) continue
    if (inputPaths.some((root) => isWithin(path, root))) stale.push(path)
  }
  return stale
}

/**
 * Whether a row matches the search box. Every whitespace-separated word must
 * appear somewhere in the path, ignoring case, so "alien 1979" finds
 * ".../Movies/Alien (1979)/Alien (1979).m4v".
 */
export function matchesSearch(path: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = path.toLowerCase()
  return words.every((word) => haystack.includes(word))
}
