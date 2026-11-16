/**
 * Which update package belongs to which platform.
 *
 * The updater reads one manifest for every platform, and an entry is only as
 * good as the name it was matched from: a package the matcher does not
 * recognise is not an error anywhere, it is simply a platform that is never
 * offered an update. That is a failure nobody sees, so the names live here,
 * next to tests that use the ones the bundler actually writes.
 */

/** Tauri 1 zipped the Windows installers; Tauri 2 signs them as they are. */
const NSIS = /-setup\.(exe|nsis\.zip)$/
const MSI = /\.msi(\.zip)?$/

/**
 * The updater's platform keys for an update package, or none if it is not one.
 *
 * A universal build covers both Macs from one file, which is the only reason
 * this returns a list rather than a single key.
 */
export function platformsFor(name) {
  if (name.endsWith('.app.tar.gz')) {
    if (name.includes('_universal')) return ['darwin-aarch64', 'darwin-x86_64']
    if (name.includes('aarch64') || name.includes('arm64')) return ['darwin-aarch64']
    if (name.includes('x64') || name.includes('x86_64')) return ['darwin-x86_64']
    return []
  }
  if (NSIS.test(name) || MSI.test(name)) return ['windows-x86_64']
  if (name.endsWith('.AppImage.tar.gz')) return ['linux-x86_64']
  return []
}

/** NSIS is what PlexFixer ships on Windows, so it wins over the MSI. */
export function preferred(existing, candidate) {
  if (!existing) return true
  return MSI.test(existing) && NSIS.test(candidate)
}
