/**
 * A PlexFixer-branded copy of the Electron bundle, for `npm run dev` on macOS.
 *
 * macOS names the app menu, the Dock tooltip and ⌘-Tab after the running
 * bundle's `CFBundleName`, whatever the menu template says — and in dev the
 * running bundle is the stock `Electron.app`. Packaged builds get the name from
 * electron-builder's `productName`; this gives dev the same, by launching a
 * renamed copy through electron-vite's `ELECTRON_EXEC_PATH`.
 *
 * The copy lives under node_modules/.cache, so a reinstall throws it away with
 * Electron itself, and it is rebuilt only when the Electron version changes.
 * Anything going wrong here falls back to the stock bundle: a dev launch
 * should never fail over a name.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron')
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'plexfixer-dev')
const BUNDLE = path.join(CACHE_DIR, 'PlexFixer.app')
const STAMP = path.join(CACHE_DIR, 'electron-version')
const ICON_SOURCE = path.join(ROOT, 'build', 'icon.png')

const NAME = 'PlexFixer'
// Its own identity, so LaunchServices never confuses it with the released app.
const BUNDLE_ID = 'com.timothyweaver.plexfixer.dev'

const run = (command, args) => execFileSync(command, args, { stdio: 'pipe' })

/** Electron's icon swapped for ours. Optional: the name is what matters. */
function replaceIcon(resources) {
  const work = mkdtempSync(path.join(tmpdir(), 'plexfixer-icon-'))
  try {
    const iconset = path.join(work, 'icon.iconset')
    run('mkdir', [iconset])
    for (const size of [16, 32, 128, 256, 512]) {
      run('sips', ['-z', String(size), String(size), ICON_SOURCE, '--out', path.join(iconset, `icon_${size}x${size}.png`)])
      const double = size * 2
      run('sips', ['-z', String(double), String(double), ICON_SOURCE, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)])
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'electron.icns')])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function build(source, version) {
  rmSync(CACHE_DIR, { recursive: true, force: true })
  run('mkdir', ['-p', CACHE_DIR])
  // An APFS clone: instant, and no extra disk for a ~250 MB bundle.
  try {
    run('cp', ['-cR', source, BUNDLE])
  } catch {
    run('cp', ['-R', source, BUNDLE])
  }

  const plist = path.join(BUNDLE, 'Contents', 'Info.plist')
  run('plutil', ['-replace', 'CFBundleName', '-string', NAME, plist])
  run('plutil', ['-replace', 'CFBundleDisplayName', '-string', NAME, plist])
  run('plutil', ['-replace', 'CFBundleIdentifier', '-string', BUNDLE_ID, plist])

  try {
    if (existsSync(ICON_SOURCE)) replaceIcon(path.join(BUNDLE, 'Contents', 'Resources'))
  } catch (error) {
    console.warn(`[dev] Kept Electron's icon: ${error instanceof Error ? error.message : error}`)
  }

  // Editing Info.plist breaks the seal, and Apple Silicon will not launch an
  // unsealed bundle. An ad-hoc signature is all a local dev run needs.
  run('codesign', ['--force', '--deep', '--sign', '-', BUNDLE])
  writeFileSync(STAMP, version)
}

/** The branded executable to launch, or undefined to use the stock Electron. */
export function ensureDevBundle() {
  if (process.platform !== 'darwin') return undefined
  try {
    // `path.txt` is how the electron package itself finds its binary.
    const executable = readFileSync(path.join(ELECTRON_DIR, 'path.txt'), 'utf8').trim()
    const marker = '.app/'
    const at = executable.indexOf(marker)
    if (at < 0) throw new Error(`unexpected Electron path "${executable}"`)
    const source = path.join(ELECTRON_DIR, 'dist', executable.slice(0, at + marker.length - 1))
    const insideBundle = executable.slice(at + marker.length)
    const version = JSON.parse(readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8')).version

    const current = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').trim() : undefined
    const target = path.join(BUNDLE, insideBundle)
    if (current !== version || !existsSync(target)) {
      console.log(`[dev] Preparing a ${NAME}-named copy of Electron ${version}…`)
      build(source, version)
    }
    return target
  } catch (error) {
    console.warn(
      `[dev] Launching as "Electron": could not prepare the ${NAME} bundle (${error instanceof Error ? error.message : error})`
    )
    return undefined
  }
}
