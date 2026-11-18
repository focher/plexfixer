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
 *   --publish        attach what was built to the GitHub release
 *   --tag=NAME       the release to attach it to (default: v<version>)
 *   --repo=OWNER/N   the repository (default: $GH_REPO, or the git remote)
 *
 * Artifacts are collected into `release/`. Nothing here notarizes: PlexFixer
 * is signed but deliberately not notarized, and the DMG's unblock script is
 * the answer to that.
 *
 * Credentials — the update signing key, the GitHub repository — are read from
 * `plexfixer.env` at the root of the clone if it is there. That file is
 * gitignored and is never written to, so copying it to a second machine is all
 * that is needed to build a signed release there.
 *
 * `--publish` is the step that makes a build other people can get hold of, so
 * it is opt-in and never implied: a build is routinely run to check a change
 * compiles, and that must not touch a release. It needs the GitHub CLI, which
 * is also what provides the credentials — nothing here handles a token.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './lib/env.mjs'
import { repository } from './lib/github.mjs'
import { UNAVAILABLE, qtFaststartName, qtFaststartPending } from './lib/qt-faststart.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// Before anything reads the environment: the signing key and the repository
// both come from here when the machine has not been set up another way.
const loaded = loadEnv(ROOT)

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

const KNOWN_FLAGS = ['--no-sign', '--no-updater', '--no-fetch', '--keep', '--publish', '--help']
/** Options written `--name=value`, as opposed to the bare flags above. */
const VALUE_FLAGS = ['--identity=', '--tag=', '--repo=']

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const names = args.filter((arg) => !arg.startsWith('--'))
const wanted = names.length > 0 ? names : [NATIVE]

/** The value of a `--name=value` option, or undefined if it was not given. */
function option(name) {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

const identityFlag = option('identity')

const usage =
  `usage: node scripts/dist.mjs [target...] [options]\n\n` +
  `targets: ${Object.keys(TARGETS).join(', ')}  (default on this machine: ${NATIVE})\n` +
  `options: ${KNOWN_FLAGS.filter((flag) => flag !== '--help').join(', ')}, ` +
  `${VALUE_FLAGS.map((prefix) => `${prefix}VALUE`).join(', ')}\n`

if (flags.has('--help')) {
  console.log(usage)
  process.exit(0)
}

// An unrecognised flag means the command was not the one that was meant, and
// a build is far too slow to start on a guess.
for (const flag of flags) {
  if (!KNOWN_FLAGS.includes(flag) && !VALUE_FLAGS.some((prefix) => flag.startsWith(prefix))) {
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

/** Run a command for whether it worked, for the ones allowed to fail. */
function attempt(command, commandArgs) {
  return spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8' }).status === 0
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
    const entries = readdirSync(dir).filter((entry) => !entry.startsWith('.'))
    if (entries.length === 0) return true
    // qt-faststart arrived after the binaries did, so a folder filled in
    // before it exists has ffmpeg and no qt-faststart. The fetch is cheap when
    // everything is there, and it leaves a note behind on a machine that
    // cannot compile one, so this does not ask again for nothing — but a note
    // only settles the question while it still describes how this builds
    // today. Deciding that here from the note's own text is what lets a build
    // carrying a fix retry what the note was complaining about.
    const marker = join(dir, UNAVAILABLE)
    return qtFaststartPending({
      hasBinary: existsSync(join(dir, qtFaststartName(folder))),
      note: existsSync(marker) ? readFileSync(marker, 'utf8') : undefined,
    })
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

/**
 * Refuse to start without the dependencies the build runs through.
 *
 * Tauri's `beforeBuildCommand` builds the renderer with vite, so a clone that
 * has not been installed fails partway into the Tauri build with "'vite' is
 * not recognized" — which reads like a broken PATH and is really a missing
 * `npm ci`. Cheaper to say so before the ffmpeg download than after it.
 */
function checkDependencies() {
  if (existsSync(join(ROOT, 'node_modules', 'vite'))) return
  throw new Error(
    'The renderer is built with vite, which is not installed.\n' +
      '  Run: npm ci',
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
    // Said as a file to put in place rather than as a shell command, because
    // the shell differs by platform and the file does not.
    throw new Error(
      'TAURI_SIGNING_PRIVATE_KEY is not set, so the signed update artifacts cannot be built.\n' +
        `  Copy plexfixer.env from a machine that has it to ${ROOT}\n` +
        '  (it is gitignored, so it will not be committed), then run this again.\n' +
        '  Or build the installer without an in-app update:  --no-updater',
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

/**
 * Attach what this run built to a GitHub release.
 *
 * Only the files this run produced are uploaded, never the whole of
 * `release/`. That is the important part: `latest.json` has to be written
 * from every platform's artifacts at once, so a Windows-only build that
 * uploaded its own manifest would withdraw the update from every Mac. Leaving
 * the manifest to `release-manifest.mjs`, run once the artifacts are
 * together, is what keeps that from being possible by accident.
 */
function publish(built) {
  if (built.length === 0) throw new Error('nothing was built, so there is nothing to publish')

  if (!capture('gh', ['--version'])) {
    throw new Error(
      'Publishing needs the GitHub CLI, and gh is not on PATH.\n' +
        '  Install it from https://cli.github.com, then: gh auth login',
    )
  }

  const repo = repository({ root: ROOT, given: option('repo') })
  const tag = option('tag') ?? `v${version()}`

  // A release that does not exist yet is created as a draft. Publishing it is
  // a decision about release notes and timing, not something a build makes.
  if (!capture('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName'])) {
    console.log(`\n  ${tag} is not on ${repo} yet — creating it as a draft`)
    run('gh', ['release', 'create', tag, '--repo', repo, '--draft', '--title', tag, '--notes', ''])
  }

  console.log(`\n=== publishing to ${repo} ${tag} ===`)
  run('gh', ['release', 'upload', tag, ...built, '--repo', repo, '--clobber'])
  for (const file of built.sort()) console.log(`  uploaded ${basename(file)}`)

  refreshManifest(repo, tag)
}

/**
 * Rebuild `latest.json` so it covers every platform on the release.
 *
 * The updater reads one manifest for all platforms, so a build that wrote its
 * own would withdraw the update from the platforms it did not produce — which
 * is the trap in building Windows on one machine and macOS on another. The
 * signatures already on the release are fetched first and the manifest is
 * written from those together with this build's, so publishing from either
 * machine leaves a release that is complete rather than one that is only
 * right about the platform that went last.
 */
function refreshManifest(repo, tag) {
  const outDir = join(ROOT, 'release')

  // Signatures only: a few hundred bytes each, where the packages they belong
  // to are tens of megabytes. Nothing matching is normal — it is what the
  // first publish to a tag looks like — so this is allowed to fail.
  const merged = attempt('gh', [
    'release', 'download', tag, '--repo', repo, '--pattern', '*.sig', '--dir', outDir, '--clobber',
  ])
  console.log(
    merged
      ? '\n  merged with the signatures already on the release'
      : '\n  nothing already on the release to merge with',
  )

  const manifest = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'release-manifest.mjs'), '--tag', tag, '--repo', repo, '--dir', outDir],
    { cwd: ROOT, stdio: 'inherit' },
  )
  if (manifest.status !== 0) {
    // The only way this fails is with nothing signed anywhere, which is what
    // --no-updater produces. The installers are published and usable; it is
    // the in-app update that is not on offer, and saying so is better than
    // failing a publish that worked.
    console.warn(
      '\n  No update packages on this release, so latest.json was not written.\n' +
        '  The installers are published. Building with a signing key in\n' +
        '  TAURI_SIGNING_PRIVATE_KEY is what puts a platform on the updater.',
    )
    return
  }

  run('gh', ['release', 'upload', tag, join(outDir, 'latest.json'), '--repo', repo, '--clobber'])
  console.log('  uploaded latest.json')
}

try {
  for (const name of wanted) checkHost(name)
  checkDependencies()

  // Names only. One of these is a signing key and another is a token, and a
  // build log is pasted into chats and issues without a second thought.
  if (loaded.length > 0) {
    console.log(`Loaded from plexfixer.env: ${loaded.join(', ')}`)
  }

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

  if (flags.has('--publish')) publish(built)
} catch (error) {
  // These failures are all ones someone has to act on — a missing toolchain, a
  // target this machine cannot build — so they are reported as instructions
  // rather than as a stack trace.
  console.error(`\n${error.message}`)
  process.exit(1)
}
