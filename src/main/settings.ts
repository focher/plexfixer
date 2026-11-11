/**
 * Persisted application settings.
 *
 * Stored as JSON in Electron's `userData` directory. Writes are atomic
 * (write-then-rename) so a crash mid-save cannot leave a truncated file that
 * resets every preference.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { AppSettings } from '@shared/types.js'
import { DEFAULT_SETTINGS, withDefaults } from '@shared/defaults.js'

// Earlier versions also stored per-path `modeOverrides`; that key is ignored
// on load and dropped on the next write.
interface StoredState {
  settings: Partial<AppSettings>
}

let cache: StoredState | undefined

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function load(): Promise<StoredState> {
  if (cache) return cache
  try {
    const raw = await readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredState>
    cache = { settings: parsed.settings ?? {} }
  } catch {
    // Missing or corrupt file: start from defaults rather than failing to boot.
    cache = { settings: {} }
  }
  return cache
}

async function persist(state: StoredState): Promise<void> {
  cache = state
  const target = filePath()
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  await rename(temporary, target)
}

export async function getSettings(): Promise<AppSettings> {
  const state = await load()
  return withDefaults(state.settings)
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const state = await load()
  const next: StoredState = { ...state, settings: { ...state.settings, ...patch } }
  await persist(next)
  return withDefaults(next.settings)
}

export async function resetSettings(): Promise<AppSettings> {
  await persist({ settings: {} })
  return { ...DEFAULT_SETTINGS }
}
