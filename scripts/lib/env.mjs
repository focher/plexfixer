/**
 * Load `plexfixer.env` into the environment.
 *
 * The file holds the things a build needs but a repository must not: the
 * update signing key above all. It is gitignored, and this only ever reads it.
 *
 * It exists because the alternative is per-shell instructions. `set -a && .
 * ./plexfixer.env && set +a` is a bash idiom, and the machine that builds
 * Windows is running PowerShell, where it means nothing — so the key would
 * have to be set by hand, in a way that lasts, on the one platform where
 * getting it wrong silently produces a release the updater cannot offer.
 * Reading the file here makes the key a file to copy across and nothing else.
 *
 * Variables already set win over the file. CI sets them from its own secrets
 * and must stay in charge of them, and it keeps a one-off override on the
 * command line working.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Strip one layer of matching quotes, which a value with spaces will have. */
function unquote(value) {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  return quoted ? quoted[1] : value
}

/**
 * Apply `plexfixer.env` from `root`, returning the names it set.
 *
 * A missing file is not an error: most runs do not need any of this, and the
 * ones that do fail later with a message about the variable they wanted.
 */
export function loadEnv(root, name = 'plexfixer.env') {
  const path = join(root, name)
  if (!existsSync(path)) return []

  const applied = []
  // Split on \r?\n: a file copied to Windows and saved there comes back with
  // CRLF, and a signing key with a stray \r on the end is rejected with an
  // error that says nothing about why.
  for (const line of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const separator = trimmed.indexOf('=')
    if (separator < 1) continue

    const key = trimmed.slice(0, separator).replace(/^export\s+/, '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (key in process.env) continue

    // An empty value is set rather than skipped. The signing key's password is
    // empty, and `undefined` and `''` differ: unset, the Tauri CLI stops to
    // prompt for one, which in a script means a build that hangs.
    process.env[key] = unquote(trimmed.slice(separator + 1).trim())
    applied.push(key)
  }
  return applied
}
