/**
 * Persisted application settings and per-path mode overrides.
 *
 * Stored as JSON in Electron's `userData` directory. Writes are atomic
 * (write-then-rename) so a crash mid-save cannot leave a truncated file that
 * resets every preference.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { AppSettings, ModeOverrides, RepairMode } from '@shared/types.js'
import { DEFAULT_SETTINGS, withDefaults } from '@shared/defaults.js'

interface StoredState {
  settings: Partial<AppSettings>
  /** Keyed by absolute path; a key may be a file or a folder. */
  modeOverrides: ModeOverrides
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
    cache = {
      settings: parsed.settings ?? {},
      modeOverrides: parsed.modeOverrides ?? {}
    }
  } catch {
    // Missing or corrupt file: start from defaults rather than failing to boot.
    cache = { settings: {}, modeOverrides: {} }
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
  // Overrides are kept: resetting the preferences is not a request to forget
  // which folders were deliberately set to something else.
  await persist({ settings: {}, modeOverrides: (await load()).modeOverrides })
  return { ...DEFAULT_SETTINGS }
}

export async function getModeOverrides(): Promise<ModeOverrides> {
  return { ...(await load()).modeOverrides }
}

/** Set, or with `null` clear, the override on one path. */
export async function setModeOverride(path: string, mode: RepairMode | null): Promise<ModeOverrides> {
  const state = await load()
  const overrides = { ...state.modeOverrides }
  if (mode === null) delete overrides[path]
  else overrides[path] = mode
  await persist({ ...state, modeOverrides: overrides })
  return overrides
}
