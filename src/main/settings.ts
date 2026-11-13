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

/**
 * Every write queues behind the one before it.
 *
 * The UI changes settings far more often than it looks: a text field saves on
 * every keystroke, and the remote toggle saves while the environment is still
 * being re-probed. Two of those overlapping used to share one temporary file —
 * the first rename moved it away, the second failed with ENOENT, and in the
 * worst interleaving a half-written file was renamed into place and every
 * preference in it was lost. Read-modify-write runs in this queue so each
 * update sees the one before it.
 */
let writes: Promise<unknown> = Promise.resolve()

function queue<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work)
  // A failed write must not break the queue for the next one.
  writes = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function load(): Promise<StoredState> {
  if (cache) return cache
  let raw: string | undefined
  try {
    raw = await readFile(filePath(), 'utf8')
  } catch {
    // No file yet: a first run, and defaults are exactly right.
    cache = { settings: {}, modeOverrides: {} }
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredState>
    cache = {
      settings: parsed.settings ?? {},
      modeOverrides: parsed.modeOverrides ?? {}
    }
  } catch (error) {
    // There was a file and it did not parse. Starting from defaults is the
    // only way to boot, but the next save would overwrite the evidence, so it
    // is kept: someone may want their preferences back, and a silent reset is
    // indistinguishable from the app forgetting everything on its own.
    const kept = `${filePath()}.corrupt-${Date.now()}`
    try {
      await rename(filePath(), kept)
      console.error(`settings.json could not be read; it has been kept at ${kept}`, error)
    } catch (renameError) {
      console.error('settings.json could not be read, and could not be set aside', renameError)
    }
    cache = { settings: {}, modeOverrides: {} }
  }
  return cache
}

let writeCount = 0

async function persist(state: StoredState): Promise<void> {
  cache = state
  const target = filePath()
  // Unique per write: a shared name lets one write rename another's file.
  const temporary = `${target}.${process.pid}.${++writeCount}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  await rename(temporary, target)
}

export async function getSettings(): Promise<AppSettings> {
  const state = await load()
  return withDefaults(state.settings)
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return queue(async () => {
    const state = await load()
    const next: StoredState = { ...state, settings: { ...state.settings, ...patch } }
    await persist(next)
    return withDefaults(next.settings)
  })
}

export async function resetSettings(): Promise<AppSettings> {
  return queue(async () => {
    // Overrides are kept: resetting the preferences is not a request to forget
    // which folders were deliberately set to something else.
    await persist({ settings: {}, modeOverrides: (await load()).modeOverrides })
    return { ...DEFAULT_SETTINGS }
  })
}

export async function getModeOverrides(): Promise<ModeOverrides> {
  return { ...(await load()).modeOverrides }
}

/** Set, or with `null` clear, the override on one path. */
export async function setModeOverride(path: string, mode: RepairMode | null): Promise<ModeOverrides> {
  return queue(async () => {
    const state = await load()
    const overrides = { ...state.modeOverrides }
    if (mode === null) delete overrides[path]
    else overrides[path] = mode
    await persist({ ...state, modeOverrides: overrides })
    return overrides
  })
}
