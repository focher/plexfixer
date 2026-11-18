/**
 * A small concurrency-limited task queue with cancellation.
 *
 * Deliberately not a dependency: the requirements are "run N at a time, let me
 * cancel one or all of them, tell me when each finishes".
 */

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
    this.concurrency = Math.max(1, Math.min(16, value))
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
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds--
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

  cancelAll(): void {
    this.pending.length = 0
    for (const controller of this.controllers.values()) controller.abort()
  }

  private pump(): void {
    while (this.holds === 0 && this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()
      if (!task) return
      const controller = new AbortController()
      this.controllers.set(task.id, controller)
      this.active++

      void task
        .run(controller.signal)
        .catch(() => {
          // The caller's promise already carries the rejection; swallowing it
          // here keeps an unhandled rejection from tearing down the process.
        })
        .finally(() => {
          this.controllers.delete(task.id)
          this.active--
          this.pump()
        })
    }
  }
}
