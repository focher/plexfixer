/**
 * The names the updater's manifest is built from.
 *
 * A package whose name is not recognised is not an error anywhere — it is a
 * platform that is quietly never offered an update, which is how Windows came
 * to be missing from a release that had the installer attached to it. The
 * fixtures here are the names the bundler actually wrote for 0.2.1.
 */

import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM helper shared with the build scripts
import { platformsFor, preferred } from '../scripts/lib/update-artifacts.mjs'

describe('platformsFor', () => {
  it('matches the Windows installer Tauri 2 signs', () => {
    // Tauri 1 zipped this into -setup.nsis.zip. Tauri 2 signs the installer
    // itself, so a matcher that only knew the zip found nothing at all.
    expect(platformsFor('PlexFixer_0.2.1_x64-setup.exe')).toEqual(['windows-x86_64'])
    expect(platformsFor('PlexFixer_0.2.1_x64_en-US.msi')).toEqual(['windows-x86_64'])
  })

  it('still matches what Tauri 1 produced', () => {
    expect(platformsFor('PlexFixer_0.2.1_x64-setup.nsis.zip')).toEqual(['windows-x86_64'])
    expect(platformsFor('PlexFixer_0.2.1_x64_en-US.msi.zip')).toEqual(['windows-x86_64'])
  })

  it('tells the two Macs apart', () => {
    expect(platformsFor('PlexFixer_0.2.1_aarch64.app.tar.gz')).toEqual(['darwin-aarch64'])
    expect(platformsFor('PlexFixer_0.2.1_x64.app.tar.gz')).toEqual(['darwin-x86_64'])
  })

  it('covers both Macs from a universal build', () => {
    expect(platformsFor('PlexFixer_0.2.1_universal.app.tar.gz')).toEqual([
      'darwin-aarch64',
      'darwin-x86_64'
    ])
  })

  it('matches the Linux update package', () => {
    expect(platformsFor('plexfixer_0.2.1_amd64.AppImage.tar.gz')).toEqual(['linux-x86_64'])
  })

  it('ignores what people download rather than update from', () => {
    // A DMG is an installer, not an update package: listing one would point
    // the updater at something it cannot apply.
    expect(platformsFor('PlexFixer_0.2.1_aarch64.dmg')).toEqual([])
    expect(platformsFor('latest.json')).toEqual([])
    expect(platformsFor('PlexFixer_0.2.1_x64.app.tar.gz.sig')).toEqual([])
  })
})

describe('preferred', () => {
  it('takes the first candidate when there is nothing yet', () => {
    expect(preferred(undefined, 'PlexFixer_0.2.1_x64_en-US.msi')).toBe(true)
  })

  it('replaces an MSI with the NSIS installer', () => {
    // NSIS is what PlexFixer ships, whichever order the directory listed.
    expect(preferred('PlexFixer_0.2.1_x64_en-US.msi', 'PlexFixer_0.2.1_x64-setup.exe')).toBe(true)
  })

  it('keeps the NSIS installer when an MSI turns up after it', () => {
    expect(preferred('PlexFixer_0.2.1_x64-setup.exe', 'PlexFixer_0.2.1_x64_en-US.msi')).toBe(false)
  })
})
