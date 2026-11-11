/**
 * Command-line launch options.
 *
 * Folders to scan on startup are given with `--volume <path>` (repeatable),
 * `--volume=<path>`, or as bare paths. Nothing on the command line makes the
 * app write: every repair starts from a button.
 *
 * Pure so it can be tested without Electron; the main process supplies argv.
 */

export interface LaunchOptions {
  /** Paths named with `--volume`, as given (not yet resolved or checked). */
  volumes: string[]
  /** Mistakes worth telling the user about on stderr. */
  problems: string[]
}

/**
 * Parse the user's arguments (argv with the executable, and in development the
 * app directory, already removed). Unknown switches are left alone: Chromium
 * and Electron flags arrive here too.
 */
export function parseLaunchArgs(args: string[]): LaunchOptions {
  const volumes: string[] = []
  const problems: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--volume') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) problems.push('--volume needs a path after it')
      else {
        volumes.push(value)
        i++
      }
    } else if (arg.startsWith('--volume=')) {
      const value = arg.slice('--volume='.length)
      if (value) volumes.push(value)
      else problems.push('--volume needs a path after it')
    }
  }

  return { volumes, problems }
}
