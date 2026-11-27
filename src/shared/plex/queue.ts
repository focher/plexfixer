/**
 * A small concurrency-limited task queue with cancellation.
 *
 * Deliberately not a dependency: the requirements are "run N at a time, let me
 * cancel one or all of them, tell me when each finishes".
 */

import { setFact, trace } from '../trace.js'

export interface QueuedTask<T> {
  id: string
  run: (signal: AbortSignal) => Promise<T>
}

export class TaskQueue {
  private readonly pending: QueuedTask<unknown>[] = []
  private readonly controllers = new Map<string, AbortController>()
  private active = 0
  /** How many callers are currently keeping new tasks from starting. */
  private holds = 0
  /** The last reason nothing started, so the same one is not said twice. */
  private lastBlocked: string | undefined

  constructor(private concurrency: number) {}

  /**
   * Change how many run at once, with effect now rather than next time.
   *
   * Raising it starts more immediately. Lowering it never stops anything that
   * is already running — a repair part-way through writing a file is not worth
   * throwing away to satisfy a number — so the queue simply starts nothing new
   * until enough have finished to be back under the limit.
   */
  setConcurrency(value: number): void {
    const was = this.concurrency
    this.concurrency = Math.max(1, Math.min(16, value))
    if (was !== this.concurrency) trace('queue', `how many run at once: ${was} -> ${this.concurrency}`)
    this.report()
    this.pump()
  }

  /**
   * Keep new tasks from starting until the returned function is called.
   *
   * This is what lets a whole batch be added before any of it runs. Adding is
   * slow — every file is probed on the way in — and without this the first few
   * files would be running, and competing for the same disk, long before the
   * last one had even been looked at.
   *
   * Holds nest: tasks start again once the last one is released. Releasing
   * twice does nothing. Anything already running carries on regardless; this
   * only governs what has not started.
   */
  hold(): () => void {
    this.holds++
    trace('queue', `held, so nothing new starts (holds now ${this.holds})`)
    this.report()
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds--
      trace('queue', `hold released (holds now ${this.holds})`)
      this.report()
      this.pump()
    }
  }

  /** Whether anything is keeping tasks from starting. */
  get held(): boolean {
    return this.holds > 0
  }

  get activeCount(): number {
    return this.active
  }

  get pendingCount(): number {
    return this.pending.length
  }

  /** Queue a task; the promise settles when that task finishes. */
  add<T>(task: QueuedTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        id: task.id,
        run: async (signal) => {
          try {
            const value = await task.run(signal)
            resolve(value)
            return value
          } catch (error) {
            reject(error)
            throw error
          }
        }
      })
      trace('queue', 'added', { ref: task.id })
      this.report()
      this.pump()
    })
  }

  /** Cancel a queued or running task by id. */
  cancel(id: string): boolean {
    const queuedIndex = this.pending.findIndex((task) => task.id === id)
    if (queuedIndex >= 0) {
      this.pending.splice(queuedIndex, 1)
      return true
    }
    const controller = this.controllers.get(id)
    if (controller) {
      controller.abort()
      return true
    }
    return false
  }

  /**
   * Move a waiting task to a given place in the queue.
   *
   * `index` counts from the front of what is waiting, so 0 is next out. It is
   * clamped, which is what lets "drop it at the bottom" be expressed as a
   * number past the end rather than something the caller has to measure.
   *
   * Returns the new order of what is waiting, or `undefined` when nothing
   * changed: the task has already started, has gone, or is already there.
   *
   * Only what is waiting can be reordered. A running task has a file open and
   * a temporary half written, and "run this one sooner" cannot mean anything
   * to a repair that is already under way.
   *
   * Nothing is pumped afterwards. Reordering changes which task runs next, not
   * how many may run, and a free slot would already have been filled.
   */
  moveTo(id: string, index: number): string[] | undefined {
    const from = this.pending.findIndex((task) => task.id === id)
    if (from < 0) return undefined

    const to = Math.max(0, Math.min(this.pending.length - 1, Math.trunc(index)))
    if (to === from) return undefined

    const [task] = this.pending.splice(from, 1)
    this.pending.splice(to, 0, task)
    return this.pendingIds()
  }

  /** The ids still waiting, in the order they will be started. */
  pendingIds(): string[] {
    return this.pending.map((task) => task.id)
  }

  cancelAll(): void {
    trace('queue', `cancel all: ${this.pending.length} waiting dropped, ${this.controllers.size} running aborted`)
    this.pending.length = 0
    for (const controller of this.controllers.values()) controller.abort()
    this.report()
  }

  /**
   * Say where the queue stands, for the report.
   *
   * A state rather than an event: the question someone asks about a queue that
   * has not moved is what it looks like *now*, and a history of changes
   * answers that only by being read to the end.
   */
  private report(): void {
    setFact(
      'queue',
      `${this.active} of ${this.concurrency} running, ${this.pending.length} waiting` +
        (this.holds > 0 ? `, HELD by ${this.holds}` : '')
    )
    setFact('queue running', this.controllers.size === 0 ? '(none)' : [...this.controllers.keys()].join(' '))
  }

  /** Why nothing started, when nothing did and something was waiting. */
  private blockedBecause(): string | undefined {
    if (this.pending.length === 0) return undefined
    if (this.holds > 0) return `held by ${this.holds} caller${this.holds === 1 ? '' : 's'} still adding a batch`
    if (this.active >= this.concurrency) {
      return this.concurrency === 1 ? 'the only slot is busy' : `all ${this.concurrency} slots are busy`
    }
    return undefined
  }

  private pump(): void {
    while (this.holds === 0 && this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()
      if (!task) return
      const controller = new AbortController()
      this.controllers.set(task.id, controller)
      this.active++
      const startedAt = Date.now()
      trace('queue', `started (${this.active} of ${this.concurrency} now running)`, { ref: task.id })
      this.report()

      void task
        .run(controller.signal)
        .catch(() => {
          // The caller's promise already carries the rejection; swallowing it
          // here keeps an unhandled rejection from tearing down the process.
        })
        .finally(() => {
          this.controllers.delete(task.id)
          this.active--
          trace('queue', 'finished', { ref: task.id, ms: Date.now() - startedAt })
          this.report()
          this.pump()
        })
    }

    /*
     * Said once, not once per file. A batch of eighty arrives one at a time
     * and every one of them finds the queue held, which would be eighty
     * identical lines in the middle of the one stretch of log worth reading.
     */
    const blocked = this.blockedBecause()
    if (blocked !== this.lastBlocked) {
      this.lastBlocked = blocked
      if (blocked) trace('queue', `nothing is starting: ${blocked}`)
    }
  }
}
