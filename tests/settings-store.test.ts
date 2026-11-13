/**
 * The settings file is the only record of every preference in the app, and it
 * is rewritten on every change — including one per keystroke in a text field.
 * These tests cover what that means when two of those writes overlap.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/plexfixer-settings-${process.pid}`)

vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const file = join(userData, 'settings.json')

async function freshStore(): Promise<typeof import('../src/main/settings.js')> {
  await mkdir(userData, { recursive: true })
  await writeFile(file, JSON.stringify({ settings: {}, modeOverrides: {} }), 'utf8')
  // The module caches the parsed file, so each test needs its own copy.
  vi.resetModules()
  return import('../src/main/settings.js')
}

afterAll(async () => {
  await rm(userData, { recursive: true, force: true })
})

describe('the settings store', () => {
  beforeEach(() => {
    expect(tmpdir()).toBeTruthy()
  })

  it('keeps both changes when two updates overlap', async () => {
    const { updateSettings, getSettings } = await freshStore()
    // Two settings changed at once is ordinary: the remote toggle refreshes the
    // environment while a keystroke in another field is still being saved.
    await Promise.all([updateSettings({ maxHeight: 1080 }), updateSettings({ concurrency: 4 })])
    const settings = await getSettings()
    expect(settings.maxHeight).toBe(1080)
    expect(settings.concurrency).toBe(4)
  })

  it('leaves a readable file after a burst of writes', async () => {
    const { updateSettings } = await freshStore()
    const host = 'plex@nas.local'
    // One update per keystroke, which is what typing a host actually produces.
    await Promise.all(host.split('').map((_, index) => updateSettings({ remoteHost: host.slice(0, index + 1) })))
    const raw = await readFile(file, 'utf8')
    expect(() => JSON.parse(raw) as unknown).not.toThrow()
  })

  it('keeps a file it cannot parse instead of overwriting it', async () => {
    await mkdir(userData, { recursive: true })
    await writeFile(file, '{"settings": {"maxHeight": 10', 'utf8')
    vi.resetModules()
    const { getSettings, updateSettings } = await import('../src/main/settings.js')
    // Booting from defaults is the only option, but the unreadable file is the
    // only copy of what the preferences were, so it has to survive the boot.
    expect((await getSettings()).maxHeight).toBe(2160)
    await updateSettings({ concurrency: 3 })
    const kept = (await readdir(userData)).filter((name) => name.includes('.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(await readFile(join(userData, kept[0] as string), 'utf8')).toBe('{"settings": {"maxHeight": 10')
  })

  it('does not lose the other preferences when one field is cleared', async () => {
    const { updateSettings, getSettings } = await freshStore()
    await updateSettings({ remoteHost: 'plex@nas.local', remoteKeyPath: '/keys/id_ed25519', maxHeight: 1080 })
    await Promise.all([updateSettings({ remoteEnabled: false }), updateSettings({ remoteHost: '' })])
    const settings = await getSettings()
    expect(settings.remoteKeyPath).toBe('/keys/id_ed25519')
    expect(settings.maxHeight).toBe(1080)
    expect(settings.remoteHost).toBe('')
    expect(settings.remoteEnabled).toBe(false)
  })
})
