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

/**
 * The selection a bulk action is allowed to touch, and what it is leaving out.
 *
 * Ticks outlive a filter on purpose: pick three files, narrow the list to look
 * at something else, widen it again, and the three are still ticked. But a
 * selection the list is not showing is a selection nobody is looking at, and a
 * bulk action that reaches it acts on files the user cannot see and did not
 * tick on this screen — "2 selected" over a list with nothing ticked in it,
 * and two other films repaired.
 *
 * So the action takes the ticks that are on screen, in the order they are on
 * screen, and the rest are reported separately rather than acted on. Clearing
 * the selection still clears the lot: that is the one control that means every
 * tick, and it says so.
 */
export function actionableSelection(
  selected: ReadonlySet<string>,
  visibleOrder: readonly string[],
  known: (path: string) => boolean
): { paths: string[]; hidden: number } {
  const onScreen = visibleOrder.filter((path) => selected.has(path))
  const shown = new Set(onScreen)
  let hidden = 0
  for (const path of selected) {
    // A path the library no longer holds is gone, not hidden; it is dropped
    // with the scan that lost it and should not be counted against anything.
    if (!shown.has(path) && known(path)) hidden += 1
  }
  return { paths: onScreen, hidden }
}
