/**
 * The scanned library, kept in IndexedDB so it survives restarts.
 *
 * Only the probe is stored, never the analysis: verdicts depend on settings, so
 * they are recomputed from the probe on load and whenever a setting changes,
 * which takes milliseconds where re-probing a library takes minutes.
 */

import type { AnalysisResult, MediaFile } from '@shared/types.js'

export { isWithin, matchesSearch, stalePaths } from '@shared/library.js'

export interface LibraryEntry {
  /** Absolute path; the key. */
  path: string
  file: MediaFile
  scannedAt: number
  /** The folder the file was found under. */
  scanRoot?: string
}

const DB_NAME = 'plexfixer'
const DB_VERSION = 1
const STORE = 'files'

let opening: Promise<IDBDatabase> | undefined

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'path' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return opening
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Library write aborted'))
  })
}

export function entryFromResult(result: AnalysisResult, scanRoot = result.scanRoot): LibraryEntry {
  return { path: result.file.path, file: result.file, scannedAt: result.scannedAt ?? Date.now(), scanRoot }
}

export async function loadLibrary(): Promise<LibraryEntry[]> {
  const database = await db()
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    request.onsuccess = () => resolve(request.result as LibraryEntry[])
    request.onerror = () => reject(request.error)
  })
}

/**
 * Forget every scanned file.
 *
 * `clear()` empties the store in one step rather than deleting each key, so a
 * library of thousands is one transaction either way. Only the record of the
 * scan goes: nothing here has ever touched the media files themselves.
 */
export async function clearLibrary(): Promise<void> {
  const database = await db()
  const transaction = database.transaction(STORE, 'readwrite')
  transaction.objectStore(STORE).clear()
  await done(transaction)
}

/** Add or replace entries and delete paths, in one transaction. */
export async function writeLibrary(put: LibraryEntry[], remove: string[] = []): Promise<void> {
  if (put.length === 0 && remove.length === 0) return
  const database = await db()
  const transaction = database.transaction(STORE, 'readwrite')
  const store = transaction.objectStore(STORE)
  for (const path of remove) store.delete(path)
  for (const entry of put) store.put(entry)
  await done(transaction)
}
