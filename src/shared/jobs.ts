/**
 * What the queue list shows.
 *
 * "Completed" is narrower than "finished": a repair that failed, was cancelled
 * or was skipped has also stopped running, but it has not done what it set out
 * to do. The distinction matters because the queue's one filter exists to get
 * the successes out of the way, and a failure is the single thing on that page
 * worth reading. Hiding completed repairs must never take a failure with them.
 *
 * The toolbar's "Clear finished" button uses the wider sense, which is right
 * for a button whose job is to empty the list.
 */

import type { Job, JobState } from './types.js'

/** A repair that finished and succeeded. */
export function isCompleted(state: JobState): boolean {
  return state === 'done'
}

/** How many of these the "Hide completed" switch would take off the screen. */
export function countCompleted(jobs: readonly Job[]): number {
  return jobs.reduce((total, job) => total + (isCompleted(job.state) ? 1 : 0), 0)
}

/** The jobs to draw, given the switch. */
export function visibleJobs(jobs: readonly Job[], hideCompleted: boolean): Job[] {
  return hideCompleted ? jobs.filter((job) => !isCompleted(job.state)) : [...jobs]
}

/**
 * Put the waiting repairs back in a new order, leaving every other row alone.
 *
 * The list mixes what is waiting with what is running and what has finished,
 * and only the waiting part has an order anyone can change. So the rows that
 * are waiting keep the *places* they occupy in the list and are dealt back
 * into them in the given order: a running repair stays exactly where it was,
 * and a finished one goes on being the record of something that happened.
 *
 * The runner and the window both do this, to the same list, from the same new
 * order — which is why it is one function and not two. A disagreement between
 * them would show up as a row that moved on screen and not in the queue.
 *
 * `order` must name exactly the rows that are waiting. Anything else is a
 * disagreement about what is waiting, not an order to be applied, so the list
 * comes back untouched.
 */
export function withQueuedOrder<T extends { id: string }>(
  rows: readonly T[],
  isWaiting: (row: T) => boolean,
  order: readonly string[]
): T[] {
  const slots: number[] = []
  const waiting = new Set<string>()
  rows.forEach((row, index) => {
    if (!isWaiting(row)) return
    slots.push(index)
    waiting.add(row.id)
  })

  if (order.length !== slots.length) return [...rows]
  if (!order.every((id) => waiting.has(id))) return [...rows]
  // Guards against a repeated id, which would leave one slot filled twice and
  // another holding a row that is no longer anywhere else in the list.
  if (new Set(order).size !== order.length) return [...rows]

  const byId = new Map(rows.map((row) => [row.id, row]))
  const next = [...rows]
  order.forEach((id, position) => {
    const row = byId.get(id)
    if (row) next[slots[position]] = row
  })
  return next
}
