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

/* ------------------------------------------------------------------ *
 * What a run of forty files came to
 * ------------------------------------------------------------------ */

/**
 * One group in the summary: a count, a name, and the rows it stands for.
 *
 * `states` and `outcomes` are what the group is *made of*, kept so that
 * pressing it can show exactly those rows rather than a filter that happens to
 * look similar.
 */
export interface OutcomeGroup {
  key: string
  /** Plural form; the caller adds the count in front. */
  label: string
  /** The sentence under it, when the group is worth explaining. */
  hint?: string
  count: number
  /** 'ok' | 'warn' | 'fail' | 'neutral', for how it is drawn. */
  tone: 'ok' | 'warn' | 'fail' | 'neutral'
  matches: (job: Job) => boolean
}

/**
 * What a batch did, in the terms a person would use to describe it.
 *
 * Built from the job's own `outcome` rather than from its message, because the
 * message is prose and prose cannot be counted. The groups are deliberately
 * not the same as the states: "skipped" covers a file that was already perfect
 * and a file nothing can fix, and the whole reason to summarise a run is to
 * stop those two arriving as one number.
 *
 * Empty groups are left out, so a run where everything worked says one thing
 * and nothing else.
 */
export function summarizeOutcomes(jobs: readonly Job[]): OutcomeGroup[] {
  const is =
    (...outcomes: NonNullable<Job['outcome']>[]) =>
    (job: Job): boolean =>
      job.outcome !== undefined && outcomes.includes(job.outcome)

  const groups: OutcomeGroup[] = [
    {
      key: 'repaired',
      label: 'repaired',
      tone: 'ok',
      count: 0,
      matches: is('repaired', 'renamed')
    },
    {
      key: 'already-right',
      label: 'already fine',
      hint: 'Nothing needed changing.',
      tone: 'neutral',
      count: 0,
      matches: is('already-right')
    },
    {
      key: 'blocked',
      label: 'nothing can fix',
      hint: 'Something is wrong with these and no repair in this app addresses it. Open a row for what you can do.',
      tone: 'warn',
      count: 0,
      matches: is('blocked')
    },
    {
      key: 'needs-transcode',
      label: 'need a re-encode',
      hint: 'A repair exists, but these files are set to Safe remux. Set them to Force transcode to run it.',
      tone: 'warn',
      count: 0,
      matches: is('needs-transcode')
    },
    {
      key: 'report-only',
      label: 'reported only',
      hint: 'Report-only mode — nothing was written.',
      tone: 'neutral',
      count: 0,
      matches: is('report-only')
    },
    {
      key: 'failed',
      label: 'failed',
      tone: 'fail',
      count: 0,
      matches: (job) => job.state === 'failed'
    },
    {
      key: 'cancelled',
      label: 'cancelled',
      tone: 'neutral',
      count: 0,
      matches: (job) => job.state === 'cancelled'
    }
  ]

  for (const job of jobs) {
    // A job still running has not done anything yet, and counting it as one
    // thing now and another later makes the line jump about while it works.
    if (job.state === 'queued' || job.state === 'running') continue
    // First match wins: `failed` is checked on state, and a job that failed
    // never got as far as having an outcome, so the two cannot double-count.
    for (const group of groups) {
      if (group.matches(job)) {
        group.count += 1
        break
      }
    }
  }

  return groups.filter((group) => group.count > 0)
}

/** How many jobs have stopped, of however many there are. */
export function settledCount(jobs: readonly Job[]): number {
  return jobs.reduce(
    (total, job) => total + (job.state === 'queued' || job.state === 'running' ? 0 : 1),
    0
  )
}
