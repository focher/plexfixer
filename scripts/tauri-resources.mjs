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
 *
 * A universal macOS build is the one case that stages two folders. Its two
 * slices are separate binaries sharing one bundle, and each looks itself up by
 * the architecture it was compiled for, so both have to be there.
 */

import { cp, mkdir, rm, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const STAGE = join(ROOT, 'src-tauri', 'resources', 'bin')

const PLATFORMS = { macos: 'darwin', windows: 'win32', linux: 'linux' }
const ARCHITECTURES = { aarch64: 'arm64', x86_64: 'x64' }

const platform = PLATFORMS[process.env.TAURI_ENV_PLATFORM ?? ''] ?? process.platform
const rustArch = process.env.TAURI_ENV_ARCH ?? ''

const folders =
  rustArch === 'universal'
    ? ['darwin-arm64', 'darwin-x64']
    : [`${platform}-${ARCHITECTURES[rustArch] ?? process.arch}`]

const staged = []
for (const folder of folders) {
  const source = join(ROOT, 'resources', 'bin', folder)

  let contents
  try {
    contents = (await readdir(source)).filter((entry) => !entry.startsWith('.'))
  } catch {
    console.error(`No ffmpeg binaries for ${folder}. Run: npm run fetch:ffmpeg -- ${folder}`)
    process.exit(1)
  }
  if (contents.length === 0) {
    console.error(`resources/bin/${folder} is empty. Run: npm run fetch:ffmpeg -- ${folder}`)
    process.exit(1)
  }

  staged.push({ folder, source, count: contents.length })
}

// The platform folders are cleared first, so a build after switching targets
// cannot ship the binaries the previous one staged. The staging directory
// itself stays: it is tracked, by way of a .gitkeep, because tauri-build
// checks the path exists while the crate compiles — before this hook runs.
await mkdir(STAGE, { recursive: true })
for (const entry of await readdir(STAGE, { withFileTypes: true })) {
  if (entry.isDirectory()) await rm(join(STAGE, entry.name), { recursive: true, force: true })
}
for (const { folder, source } of staged) {
  await cp(source, join(STAGE, folder), {
    recursive: true,
    // Dotfiles in a platform folder are bookkeeping, not payload — the note
    // left behind when qt-faststart could not be compiled on this machine is
    // one. They are already left out of the count above; leaving them out of
    // the copy as well is what keeps them out of the installer, where one of
    // them has already been shipped once.
    filter: (from) => !basename(from).startsWith('.'),
  })
}

console.log(
  staged.map(({ folder, count }) => `staged ${count} file(s) for ${folder}`).join('\n'),
)
