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

  constructor(private concurrency: number) {}

  setConcurrency(value: number): void {
    this.concurrency = Math.max(1, Math.min(16, value))
    this.pump()
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
    while (this.active < this.concurrency && this.pending.length > 0) {
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
