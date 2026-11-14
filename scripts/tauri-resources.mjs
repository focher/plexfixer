#!/usr/bin/env node
/**
 * Stage the ffmpeg binaries for the platform being bundled.
 *
 * Tauri's `resources` list is one list for every target, and the binaries are
 * 70–190 MB per platform — shipping all of them in each installer is not an
 * option. So the right platform's folder is copied into a staging directory
 * that the config points at, just before the bundler runs.
 *
 * Tauri sets `TAURI_ENV_PLATFORM` and `TAURI_ENV_ARCH` for this hook; they are
 * Rust's names, which are not Node's, so they are mapped onto the folder names
 * `npm run fetch:ffmpeg` writes.
 */

import { cp, mkdir, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const STAGE = join(ROOT, 'src-tauri', 'resources', 'bin')

const PLATFORMS = { macos: 'darwin', windows: 'win32', linux: 'linux' }
const ARCHITECTURES = { aarch64: 'arm64', x86_64: 'x64' }

const platform = PLATFORMS[process.env.TAURI_ENV_PLATFORM ?? ''] ?? process.platform
const arch = ARCHITECTURES[process.env.TAURI_ENV_ARCH ?? ''] ?? process.arch
const folder = `${platform}-${arch}`
const source = join(ROOT, 'resources', 'bin', folder)

let contents
try {
  contents = await readdir(source)
} catch {
  console.error(`No ffmpeg binaries for ${folder}. Run: npm run fetch:ffmpeg -- --all`)
  process.exit(1)
}
if (contents.length === 0) {
  console.error(`resources/bin/${folder} is empty. Run: npm run fetch:ffmpeg -- --all`)
  process.exit(1)
}

// Cleared first, so a build after switching targets cannot ship the binaries
// the previous one staged.
await rm(STAGE, { recursive: true, force: true })
await mkdir(STAGE, { recursive: true })
await cp(source, join(STAGE, folder), { recursive: true })

console.log(`staged ${contents.length} file(s) for ${folder}`)
