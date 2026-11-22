/**
 * Changing the catalog patch, one setting at a time.
 *
 * Every helper takes a patch and returns a new one, and none of them stores a
 * value equal to the shipped one: a field set back to its default leaves the
 * patch, an entry with nothing left in it goes too, and so "changed from the
 * default" is always just "present in the patch".
 */

import { DEFAULT_CATALOG } from './resolve.js'
import type { CatalogPatch, CheckEntry, FlagDef, ParamValue, RepairEntry } from './types.js'

type EntrySection = 'checks' | 'repairs' | 'flags'
type Shipped = { checks: CheckEntry; repairs: RepairEntry; flags: FlagDef }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The patch with one entry replaced, or removed when nothing in it differs from the defaults. */
function withEntry(patch: CatalogPatch, section: EntrySection, id: string, entry: Record<string, unknown>): CatalogPatch {
  const others = Object.fromEntries(Object.entries(patch[section] ?? {}).filter(([name]) => name !== id))
  const nextSection = Object.keys(entry).length > 0 ? { ...others, [id]: entry } : others
  const rest = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== section)) as CatalogPatch
  return Object.keys(nextSection).length > 0 ? { ...rest, [section]: nextSection } : rest
}

/** One field of a check, repair or flag set; dropped from the patch when it matches what shipped. */
export function setField<S extends EntrySection, K extends keyof Shipped[S]>(
  patch: CatalogPatch,
  section: S,
  id: string,
  field: K,
  value: Shipped[S][K]
): CatalogPatch {
  const shipped = (DEFAULT_CATALOG[section] as Record<string, Shipped[S]>)[id]
  const current = ((patch[section] as Record<string, Record<string, unknown>> | undefined)?.[id] ?? {}) as Record<
    string,
    unknown
  >
  const without = Object.fromEntries(Object.entries(current).filter(([name]) => name !== field))
  const entry = shipped && same(shipped[field], value) ? without : { ...without, [field as string]: value }
  return withEntry(patch, section, id, entry)
}

/** One parameter of a module set; only parameters that differ from the shipped ones are kept. */
export function setParam(
  patch: CatalogPatch,
  section: 'checks' | 'repairs',
  id: string,
  key: string,
  value: ParamValue
): CatalogPatch {
  const shipped = DEFAULT_CATALOG[section][id]?.params ?? {}
  const stored = patch[section]?.[id]?.params ?? {}
  const others = Object.fromEntries(Object.entries(stored).filter(([name]) => name !== key))
  const params = same(shipped[key], value) ? others : { ...others, [key]: value }
  const current = (patch[section]?.[id] ?? {}) as Record<string, unknown>
  const without = Object.fromEntries(Object.entries(current).filter(([name]) => name !== 'params'))
  return withEntry(patch, section, id, Object.keys(params).length > 0 ? { ...without, params } : without)
}

/** One entry back to how it shipped. */
export const resetEntry = (patch: CatalogPatch, section: EntrySection, id: string): CatalogPatch =>
  withEntry(patch, section, id, {})

/** A whole section back to how it shipped; `statuses` resets the tiles and their rules together. */
export function resetSection(patch: CatalogPatch, section: EntrySection | 'statuses'): CatalogPatch {
  const drop = section === 'statuses' ? ['statuses', 'statusRules'] : [section]
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !drop.includes(key))) as CatalogPatch
}

/** Whether anything about an entry differs from how it shipped. */
export const isChanged = (patch: CatalogPatch, section: EntrySection, id: string): boolean =>
  patch[section]?.[id] !== undefined

/** How many entries in a section differ from how they shipped. */
export const changedCount = (patch: CatalogPatch, section: EntrySection | 'statuses'): number =>
  section === 'statuses'
    ? Number(patch.statuses !== undefined || patch.statusRules !== undefined)
    : Object.keys(patch[section] ?? {}).length
