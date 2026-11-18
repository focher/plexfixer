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
