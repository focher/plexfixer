/**
 * Per-viewer UI preferences. Storage can be unavailable or cleared, so every
 * access is guarded and a missing value just means the default.
 *
 * These live apart from any one screen because more than one of them remembers
 * the state of a switch.
 */

export function readPref(key: string): boolean {
  try {
    return localStorage.getItem(`plexfixer.${key}`) === 'true'
  } catch {
    return false
  }
}

export function writePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(`plexfixer.${key}`, String(value))
  } catch {
    /* not worth surfacing */
  }
}

/**
 * The same storage for a value that is not a switch — the version whose notes
 * have been shown, so far the only one.
 */
export function readText(key: string): string | undefined {
  try {
    return localStorage.getItem(`plexfixer.${key}`) ?? undefined
  } catch {
    return undefined
  }
}

export function writeText(key: string, value: string): void {
  try {
    localStorage.setItem(`plexfixer.${key}`, value)
  } catch {
    /* not worth surfacing */
  }
}
