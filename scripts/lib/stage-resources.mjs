/**
 * Filling the directory Tauri bundles the ffmpeg binaries out of.
 *
 * Everything in that directory is generated, which is the whole reason this
 * exists: the two files that have escaped into a shipped installer so far both
 * got there by sitting in it and being copied along with the payload. The note
 * left behind by a failed qt-faststart compile was one; the .gitkeep that used
 * to hold the directory open for tauri-build was the other.
 *
 * So staging clears the directory whole rather than clearing the platform
 * folders and leaving alone whatever else happens to be lying there, and the
 * copy takes payload only.
 */

import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Whether a file is payload rather than bookkeeping.
 *
 * Dotfiles in a platform folder are notes this build leaves for the next one.
 * They are useful on the machine that builds, and have no business inside an
 * installer.
 */
export function isPayload(path) {
  return !basename(path).startsWith('.')
}

/** The payload a platform folder holds, which is what makes it worth staging. */
export async function payloadOf(source) {
  return (await readdir(source)).filter(isPayload)
}

/**
 * Empty the staging directory and copy each source folder into it.
 *
 * `sources` is `{ folder, source }` pairs: the name to stage under, and where
 * to take it from. The directory itself is left in place — tauri-build wants
 * the path to exist, and by this point the crate has already compiled against
 * it.
 */
export async function stageResources({ stage, sources }) {
  await mkdir(stage, { recursive: true })
  for (const entry of await readdir(stage)) {
    await rm(join(stage, entry), { recursive: true, force: true })
  }
  for (const { folder, source } of sources) {
    await cp(source, join(stage, folder), { recursive: true, filter: isPayload })
  }
}
