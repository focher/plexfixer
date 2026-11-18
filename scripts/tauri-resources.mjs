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

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { payloadOf, stageResources } from './lib/stage-resources.mjs'

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
    contents = await payloadOf(source)
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

// The staging directory is emptied first, so a build after switching targets
// cannot ship the binaries the previous one staged — and so nothing else that
// has collected in there is carried into the bundle either. The directory
// itself stays: build.rs creates it before the crate compiles, because
// tauri-build checks the path exists long before this hook runs.
await stageResources({ stage: STAGE, sources: staged })

console.log(
  staged.map(({ folder, count }) => `staged ${count} file(s) for ${folder}`).join('\n'),
)
