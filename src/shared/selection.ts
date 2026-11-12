/**
 * Drop selected files that just changed and no longer pass the filters.
 *
 * Only files whose library entry changed between `before` and `after` are
 * considered: a filter the user turns on does not throw away what they picked,
 * but a file that is re-scanned or repaired into a state the filters hide
 * leaves the selection, so a bulk action never reaches a row that is no
 * longer on screen for a reason the user did not choose. A file that is new
 * to the library (a repair that moved it to a new path) counts as changed.
 *
 * Returns `selected` itself when nothing is dropped, so a React state update
 * with the result is a no-op.
 */
export function pruneSelection<T>(
  selected: Set<string>,
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
  visible: ReadonlySet<string>
): Set<string> {
  let next: Set<string> | undefined
  for (const path of selected) {
    const entry = after.get(path)
    // Gone files are dropped elsewhere, with the scan or refresh that lost them.
    if (entry === undefined || entry === before.get(path) || visible.has(path)) continue
    next ??= new Set(selected)
    next.delete(path)
  }
  return next ?? selected
}
