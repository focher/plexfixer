#!/usr/bin/env node
/**
 * Put **Allow PlexFixer to open.command** into a built DMG.
 *
 * These builds are signed but not notarized, so macOS blocks the app on first
 * launch. The script in the DMG is the one-click version of the `xattr` line
 * people otherwise have to be told, and it has shipped in every release — so
 * it has to survive the move off electron-builder, whose DMG step could place
 * arbitrary files and Tauri's cannot.
 *
 * The DMG is converted back to read-write, the file is copied in, and it is
 * recompressed. The icon lands wherever the Finder puts it rather than at a
 * chosen position, which is the one thing lost in the move.
 *
 *   node scripts/dmg-add-unblock.mjs <path-to.dmg> [...]
 */

import { execFile } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname
const SCRIPT = join(ROOT, 'build', 'Allow PlexFixer to open.command')

async function addTo(dmgPath) {
  const work = await mkdtemp(join(tmpdir(), 'plexfixer-dmg-'))
  const writable = join(work, 'rw.dmg')
  const mount = join(work, 'mount')

  try {
    await run('hdiutil', ['convert', dmgPath, '-format', 'UDRW', '-o', writable])
    await run('hdiutil', ['attach', writable, '-nobrowse', '-mountpoint', mount])
    try {
      await run('cp', ['-p', SCRIPT, join(mount, basename(SCRIPT))])
    } finally {
      // Detaching has to happen even if the copy failed, or the disk stays
      // mounted and the next build cannot touch it.
      await run('hdiutil', ['detach', mount, '-force'])
    }
    await rm(dmgPath, { force: true })
    await run('hdiutil', ['convert', writable, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', dmgPath])
    console.log(`added the unblock script to ${basename(dmgPath)}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('usage: node scripts/dmg-add-unblock.mjs <path-to.dmg> [...]')
  process.exit(1)
}

await access(SCRIPT).catch(() => {
  console.error(`missing ${SCRIPT}`)
  process.exit(1)
})

for (const target of targets) await addTo(target)
