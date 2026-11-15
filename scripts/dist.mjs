#!/usr/bin/env node
/**
 * Build PlexFixer installers for one or more targets.
 *
 *   node scripts/dist.mjs                  this machine's own architecture
 *   node scripts/dist.mjs mac-intel        an Intel Mac build, from any Mac
 *   node scripts/dist.mjs mac-arm mac-intel
 *   node scripts/dist.mjs win              only on Windows — see below
 *
 * Targets: mac-arm, mac-intel, mac-universal, win, linux.
 *
 * **macOS cross-builds work; Windows ones do not.** Xcode ships both macOS
 * architectures' SDKs, so one Mac can build for the other — all that is needed
 * is the Rust target, which this script installs. Windows needs the MSVC
 * toolchain and NSIS, so it is built on Windows: run this same script there,
 * or let `.github/workflows/release.yml` do it on a runner.
 *
 * Each build embeds only its own platform's ffmpeg. The binaries are fetched
 * if they are missing, since a build that quietly ships none is worse than a
 * slow one.
 *
 * Options:
 *   --no-sign        skip macOS code signing
 *   --identity=NAME  sign with this identity rather than the detected one
 *   --no-updater     omit the signed update artifacts (no signing key needed)
 *   --no-fetch       fail on missing ffmpeg instead of downloading it
 *   --keep           add to release/ rather than emptying it first
 *
 * Artifacts are collected into `release/`. Nothing here notarizes: PlexFixer
 * is signed but deliberately not notarized, and the DMG's unblock script is
 * the answer to that.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The version the bundler will stamp on the artifacts. */
function version() {
  return JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).version
}

/**
 * Rust triple and ffmpeg folders per target. `host` is the only platform the
 * target can be built on — macOS covers both of its own architectures, every
 * other platform covers only itself.
 */
const TARGETS = {
  'mac-arm': {
    triple: 'aarch64-apple-darwin',
    ffmpeg: ['darwin-arm64'],
    host: 'darwin',
    rust: ['aarch64-apple-darwin'],
    label: 'aarch64',
    env: { platform: 'macos', arch: 'aarch64' },
  },
  'mac-intel': {
    triple: 'x86_64-apple-darwin',
    ffmpeg: ['darwin-x64'],
    host: 'darwin',
    rust: ['x86_64-apple-darwin'],
    label: 'x64',
    env: { platform: 'macos', arch: 'x86_64' },
  },
  'mac-universal': {
    triple: 'universal-apple-darwin',
    ffmpeg: ['darwin-arm64', 'darwin-x64'],
    host: 'darwin',
    rust: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
    label: 'universal',
    env: { platform: 'macos', arch: 'universal' },
  },
  win: {
    triple: 'x86_64-pc-windows-msvc',
    ffmpeg: ['win32-x64'],
    host: 'win32',
    rust: ['x86_64-pc-windows-msvc'],
    env: { platform: 'windows', arch: 'x86_64' },
  },
  linux: {
    triple: 'x86_64-unknown-linux-gnu',
    ffmpeg: ['linux-x64'],
    host: 'linux',
    rust: ['x86_64-unknown-linux-gnu'],
    env: { platform: 'linux', arch: 'x86_64' },
  },
}

/** What this machine builds when no target is named. */
const NATIVE =
  process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'mac-arm'
      : 'mac-intel'
    : process.platform === 'win32'
      ? 'win'
      : 'linux'

const KNOWN_FLAGS = ['--no-sign', '--no-updater', '--no-fetch', '--keep', '--help']

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const identityFlag = args.find((arg) => arg.startsWith('--identity='))?.slice('--identity='.length)
const names = args.filter((arg) => !arg.startsWith('--'))
const wanted = names.length > 0 ? names : [NATIVE]

const usage =
  `usage: node scripts/dist.mjs [target...] [options]\n\n` +
  `targets: ${Object.keys(TARGETS).join(', ')}  (default on this machine: ${NATIVE})\n` +
  `options: ${KNOWN_FLAGS.filter((flag) => flag !== '--help').join(', ')}, --identity=NAME\n`

if (flags.has('--help')) {
  console.log(usage)
  process.exit(0)
}

// An unrecognised flag means the command was not the one that was meant, and
// a build is far too slow to start on a guess.
for (const flag of flags) {
  if (!KNOWN_FLAGS.includes(flag) && !flag.startsWith('--identity=')) {
    console.error(`Unknown option "${flag}".\n\n${usage}`)
    process.exit(1)
  }
}

for (const name of wanted) {
  if (!TARGETS[name]) {
    console.error(`Unknown target "${name}".\n\n${usage}`)
    process.exit(1)
  }
}

/** Run a command, inheriting stdio, and stop the build if it fails. */
function run(command, commandArgs, options = {}) {
  // No `shell`, on Windows above all: cmd.exe would eat the quotes in the
  // JSON that `--config` is passed. Everything run here — cargo, rustup, node
  // — is an .exe that CreateProcess resolves without one.
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  })
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${command} is not on PATH. Install it and try again.`)
  }
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
  }
}

/** Run a command for its output, returning '' rather than throwing. */
function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8' })
  return result.status === 0 ? (result.stdout ?? '') : ''
}

/**
 * Install the Rust targets a build needs.
 *
 * `rustup target add` only downloads a prebuilt standard library, and is a
 * no-op when it is already there, so it is done rather than demanded — the
 * alternative is a build that fails on a line the person then has to paste
 * back.
 */
function ensureRustTargets(target) {
  const listed = capture('rustup', ['target', 'list', '--installed'])
  if (!listed) {
    // Rust installed some other way than rustup. Nothing to add, and cargo
    // will say so clearly enough if the target really is missing.
    console.warn('  rustup not available — leaving the installed targets alone')
    return
  }
  const installed = listed.split('\n').map((line) => line.trim())
  for (const triple of target.rust) {
    if (installed.includes(triple)) continue
    console.log(`\n  installing Rust target ${triple}`)
    run('rustup', ['target', 'add', triple])
  }
}

/** Download the ffmpeg binaries a target needs, unless --no-fetch. */
function ensureFfmpeg(target) {
  const missing = target.ffmpeg.filter((folder) => {
    const dir = join(ROOT, 'resources', 'bin', folder)
    if (!existsSync(dir)) return true
    return readdirSync(dir).filter((entry) => !entry.startsWith('.')).length === 0
  })
  if (missing.length === 0) return

  if (flags.has('--no-fetch')) {
    throw new Error(
      `missing ffmpeg for ${missing.join(', ')} — run: npm run fetch:ffmpeg -- ${missing.join(' ')}`,
    )
  }
  console.log(`\n  fetching ffmpeg for ${missing.join(', ')}`)
  run(process.execPath, [join(ROOT, 'scripts', 'fetch-ffmpeg.mjs'), ...missing])
}

/**
 * Stage the target's ffmpeg binaries before cargo is called.
 *
 * `beforeBundleCommand` stages them as well, but that hook runs once the
 * crate has compiled, and tauri-build checks that every `resources` path
 * exists *while* compiling. The staging directory is not in the repository,
 * so on a fresh clone the build fails before the hook has ever run — which is
 * why this only showed itself on a machine that had never built before.
 *
 * The platform and architecture are passed rather than inferred, so a
 * cross-build stages the architecture it is building for and not the one it
 * is building on.
 */
function stageResources(target) {
  run(process.execPath, [join(ROOT, 'scripts', 'tauri-resources.mjs')], {
    env: {
      ...process.env,
      TAURI_ENV_PLATFORM: target.env.platform,
      TAURI_ENV_ARCH: target.env.arch,
    },
  })
}

/**
 * The Developer ID identity to sign with, or undefined to leave the build
 * unsigned.
 *
 * Naming it explicitly rather than letting the bundler pick means a machine
 * with several certificates signs with the one that was chosen, and says which
 * one it used.
 */
function signingIdentity() {
  if (flags.has('--no-sign')) return undefined
  if (identityFlag) return identityFlag
  if (process.env.APPLE_SIGNING_IDENTITY) return process.env.APPLE_SIGNING_IDENTITY

  // On CI the certificate arrives as a base64 .p12 that the Tauri CLI imports
  // into a keychain of its own. There is nothing to find yet, and nothing to
  // decide, so the probe below is skipped.
  if (process.env.APPLE_CERTIFICATE) return undefined

  const found = capture('security', ['find-identity', '-v', '-p', 'codesigning'])
    .split('\n')
    .map((line) => line.match(/"(Developer ID Application:[^"]+)"/)?.[1])
    .filter((name) => name !== undefined)
  const unique = [...new Set(found)]

  if (unique.length === 1) return unique[0]
  if (unique.length === 0) {
    console.warn('  no Developer ID certificate in the keychain — building unsigned')
    return undefined
  }
  throw new Error(
    `${unique.length} Developer ID certificates found; choose one with --identity=\n` +
      unique.map((name) => `    --identity=${JSON.stringify(name)}`).join('\n'),
  )
}

/**
 * What a collected artifact is called in `release/`.
 *
 * The macOS update package is named after the app alone — `PlexFixer.app.tar.gz`
 * — so two architectures collected in turn would overwrite one another, and
 * the manifest would offer every Mac whichever one was built last. The version
 * and architecture go into the name here, matching what the DMG already does.
 */
function releaseName(file, target, version) {
  const name = basename(file)
  const tarball = /^(.+)\.app\.tar\.gz(\.sig)?$/.exec(name)
  if (tarball && target.label) {
    return `${tarball[1]}_${version}_${target.label}.app.tar.gz${tarball[2] ?? ''}`
  }
  return name
}

/**
 * Every installer and update artifact under a bundle directory.
 *
 * `.app` is a directory, and its contents are already inside the DMG and the
 * update tarball, so the walk does not descend into one.
 */
function artifactsIn(dir, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.endsWith('.app')) artifactsIn(full, found)
    } else if (/\.(dmg|exe|msi|deb|rpm|AppImage|zip|sig)$/.test(entry.name) || entry.name.endsWith('.tar.gz')) {
      found.push(full)
    }
  }
  return found
}

/** Refuse a target this machine cannot build, before anything is deleted. */
function checkHost(name) {
  const target = TARGETS[name]
  if (process.platform === target.host) return
  throw new Error(
    `${name} builds on ${target.host}, not ${process.platform}. ` +
      (target.host === 'win32'
        ? 'Run this script on a Windows machine, or push a tag and let\n' +
          '  .github/workflows/release.yml build it on a runner.'
        : `Run it on ${target.host}.`),
  )
}

function buildTarget(name) {
  const target = TARGETS[name]
  console.log(`\n=== ${name} (${target.triple}) ===`)

  ensureRustTargets(target)
  ensureFfmpeg(target)
  stageResources(target)

  const env = { ...process.env }
  if (target.host === 'darwin') {
    const identity = signingIdentity()
    if (identity) {
      env.APPLE_SIGNING_IDENTITY = identity
      console.log(`  signing as ${identity}`)
    } else if (env.APPLE_CERTIFICATE) {
      console.log('  signing with the certificate in APPLE_CERTIFICATE')
    } else {
      delete env.APPLE_SIGNING_IDENTITY
    }
    // Notarization is a settled no for this project. Clearing the credentials
    // keeps a stray environment variable from turning it on.
    for (const key of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_ISSUER']) {
      delete env[key]
    }
  }

  const buildArgs = ['tauri', 'build', '--target', target.triple]
  if (flags.has('--no-updater')) {
    buildArgs.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }))
  } else if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error(
      'TAURI_SIGNING_PRIVATE_KEY is not set, so the signed update artifacts cannot be built.\n' +
        '  Load it with:  set -a && . ./plexfixer.env && set +a\n' +
        '  Or build without update artifacts:  --no-updater',
    )
  }

  const bundle = join(ROOT, 'src-tauri', 'target', target.triple, 'release', 'bundle')
  // Emptied first. The bundler writes into this directory without clearing
  // it, so anything an earlier build left — an update package from before
  // `--no-updater`, an installer carrying an older version number — would be
  // collected as though this build had produced it. Only bundler output is
  // removed; the compiled objects beside it are untouched, so this costs a
  // re-bundle and not a rebuild.
  rmSync(bundle, { recursive: true, force: true })

  run('cargo', buildArgs, { env })

  const artifacts = artifactsIn(bundle)
  if (artifacts.length === 0) throw new Error(`no artifacts under ${bundle}`)

  const outDir = join(ROOT, 'release')
  mkdirSync(outDir, { recursive: true })
  const copied = []
  for (const source of artifacts) {
    const destination = join(outDir, releaseName(source, target, version()))
    cpSync(source, destination)
    copied.push(destination)
  }

  // The DMG carries the unblock script, because these builds are signed but
  // never notarized. It is added to the copy, so the build tree is left as the
  // bundler wrote it.
  const dmgs = copied.filter((file) => file.endsWith('.dmg'))
  if (dmgs.length > 0) {
    run(process.execPath, [join(ROOT, 'scripts', 'dmg-add-unblock.mjs'), ...dmgs])
  }

  return copied
}

try {
  for (const name of wanted) checkHost(name)

  if (!flags.has('--keep')) {
    rmSync(join(ROOT, 'release'), { recursive: true, force: true })
  }

  const built = []
  for (const name of wanted) built.push(...buildTarget(name))

  console.log(`\n=== release/ ===`)
  for (const file of built.sort()) {
    const megabytes = (statSync(file).size / 1024 / 1024).toFixed(1)
    console.log(`  ${basename(file).padEnd(44)} ${megabytes.padStart(7)} MB`)
  }
  console.log(`\n${built.length} file(s) in ${join(ROOT, 'release')}`)
} catch (error) {
  // These failures are all ones someone has to act on — a missing toolchain, a
  // target this machine cannot build — so they are reported as instructions
  // rather than as a stack trace.
  console.error(`\n${error.message}`)
  process.exit(1)
}
