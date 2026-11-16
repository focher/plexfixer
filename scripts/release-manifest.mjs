#!/usr/bin/env node
/**
 * Write the updater's `latest.json` from the artifacts in `release/`.
 *
 *   node scripts/release-manifest.mjs --tag v0.2.1 [--repo owner/name]
 *
 * One manifest covers every platform, so it can only be written once all of
 * them have been built — which, since Windows is built on a different machine
 * from macOS, means after their artifacts have been brought together. That is
 * what makes this a script rather than a line in the build: with one platform
 * per manifest, whichever was published last would be offered to everybody.
 *
 * Only the platforms actually present are listed. A platform left out is a
 * platform the updater tells to stay where it is, which is right — the
 * alternative is pointing it at a download that is not there.
 *
 * Options:
 *   --tag NAME    the release tag the artifacts are published under (required)
 *   --repo O/N    GitHub repository; defaults to $GH_REPO or the git remote
 *   --dir PATH    where the artifacts are (default: release)
 *   --notes TEXT  release notes shown by the update prompt
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repository as repositoryOf } from './lib/github.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index >= 0 && args[index + 1]) return args[index + 1]
  const inline = args.find((arg) => arg.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

const tag = option('tag')
// resolve, not join, so an absolute --dir is taken as given.
const dir = resolve(ROOT, option('dir', 'release'))
const notes = option('notes', '')

if (!tag) {
  console.error('usage: node scripts/release-manifest.mjs --tag v0.0.0 [--repo owner/name] [--dir release]')
  process.exit(1)
}

/** The repository the artifacts will be downloaded from. */
function repository() {
  try {
    return repositoryOf({ root: ROOT, given: option('repo') })
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

/**
 * The updater's platform keys for an update package.
 *
 * A universal build covers both Macs from one file, which is the only reason
 * this returns a list rather than a single key.
 */
function platformsFor(name) {
  if (name.endsWith('.app.tar.gz')) {
    if (name.includes('_universal')) return ['darwin-aarch64', 'darwin-x86_64']
    if (name.includes('aarch64') || name.includes('arm64')) return ['darwin-aarch64']
    if (name.includes('x64') || name.includes('x86_64')) return ['darwin-x86_64']
    return []
  }
  if (name.endsWith('-setup.nsis.zip')) return ['windows-x86_64']
  if (name.endsWith('.msi.zip')) return ['windows-x86_64']
  if (name.endsWith('.AppImage.tar.gz')) return ['linux-x86_64']
  return []
}

/** NSIS is what PlexFixer ships on Windows, so it wins over the MSI. */
function preferred(existing, candidate) {
  if (!existing) return true
  if (existing.endsWith('.msi.zip') && candidate.endsWith('-setup.nsis.zip')) return true
  return false
}

if (!existsSync(dir)) {
  console.error(`No ${dir} — build the installers first.`)
  process.exit(1)
}

const repo = repository()
const version = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).version

if (tag.replace(/^v/, '') !== version) {
  console.warn(`  warning: tag ${tag} does not match version ${version} in tauri.conf.json`)
}

const files = readdirSync(dir)
const chosen = new Map()

for (const name of files) {
  if (name.endsWith('.sig')) continue
  for (const platform of platformsFor(name)) {
    if (preferred(chosen.get(platform), name)) chosen.set(platform, name)
  }
}

const platforms = {}
const skipped = []

for (const [platform, name] of [...chosen].sort()) {
  const signaturePath = join(dir, `${name}.sig`)
  if (!existsSync(signaturePath)) {
    // Without a signature the client cannot verify the download and will
    // refuse it, so an entry here would be worse than none.
    skipped.push(`${platform}: ${name} has no .sig beside it`)
    continue
  }
  platforms[platform] = {
    signature: readFileSync(signaturePath, 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
  }
}

if (Object.keys(platforms).length === 0) {
  console.error(`No update packages in ${dir}. Expected a .app.tar.gz or -setup.nsis.zip with a .sig.`)
  if (skipped.length > 0) for (const line of skipped) console.error(`  ${line}`)
  process.exit(1)
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
}

const output = join(dir, 'latest.json')
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`${basename(output)} for ${version} at ${tag}:`)
for (const [platform, entry] of Object.entries(platforms)) {
  console.log(`  ${platform.padEnd(16)} ${basename(decodeURIComponent(entry.url))}`)
}
for (const line of skipped) console.warn(`  skipped — ${line}`)

const missing = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'].filter((key) => !platforms[key])
if (missing.length > 0) {
  console.warn(`  no update offered for: ${missing.join(', ')}`)
}
