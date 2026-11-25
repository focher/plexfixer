/**
 * When the queue starts things, as distinct from what it runs.
 *
 * Two rules live here. A batch arriving into an idle queue is held until all
 * of it is in, because adding probes every file and the first repair should
 * not be fighting those probes for the disk. And a change to how many run at
 * once applies to the run in front of you: up starts more now, down starts
 * nothing further — but never stops a repair that is already writing a file.
 */

import { describe, expect, it } from 'vitest'
import { TaskQueue } from '@shared/plex/queue.js'

/** Tasks that start when the queue says so and finish when the test says so. */
function tasks(): {
  started: string[]
  add: (queue: TaskQueue, id: string) => void
  finish: (id: string) => Promise<void>
} {
  const started: string[] = []
  const finishers = new Map<string, () => void>()
  return {
    started,
    add(queue, id) {
      void queue.add({
        id,
        run: () =>
          new Promise<void>((resolve) => {
            started.push(id)
            finishers.set(id, resolve)
          })
      })
    },
    async finish(id) {
      finishers.get(id)?.()
      // The queue starts the next task in a `finally`, which is a microtask
      // or two behind the one that resolved here.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

describe('holding the queue while a batch arrives', () => {
  it('starts nothing while held, then everything the limit allows', () => {
    const queue = new TaskQueue(2)
    const { started, add } = tasks()
    const release = queue.hold()

    for (const id of ['a', 'b', 'c']) add(queue, id)
    expect(started).toEqual([])
    expect(queue.pendingCount).toBe(3)

    release()
    expect(started).toEqual(['a', 'b'])
    expect(queue.activeCount).toBe(2)
  })

  it('stays held until the last holder releases', () => {
    const queue = new TaskQueue(2)
    const { started, add } = tasks()
    const first = queue.hold()
    const second = queue.hold()

    add(queue, 'a')
    first()
    expect(queue.held).toBe(true)
    expect(started).toEqual([])

    second()
    expect(queue.held).toBe(false)
    expect(started).toEqual(['a'])
  })

  it('ignores a second release, so one holder cannot free another', () => {
    const queue = new TaskQueue(2)
    const { started, add } = tasks()
    const first = queue.hold()
    const second = queue.hold()

    add(queue, 'a')
    first()
    first()
    expect(queue.held).toBe(true)
    expect(started).toEqual([])

    second()
    expect(started).toEqual(['a'])
  })

  it('does not start the next task when one finishes under a hold', async () => {
    const queue = new TaskQueue(1)
    const { started, add, finish } = tasks()

    add(queue, 'running')
    expect(started).toEqual(['running'])

    const release = queue.hold()
    add(queue, 'waiting')
    await finish('running')
    expect(started).toEqual(['running'])

    release()
    expect(started).toEqual(['running', 'waiting'])
  })

  it('leaves a queue that is already working alone', () => {
    // What the runner checks before deciding to hold at all.
    const queue = new TaskQueue(2)
    const { add } = tasks()
    add(queue, 'a')
    expect(queue.activeCount).toBe(1)
  })
})

describe('changing how many run at once', () => {
  it('starts more as soon as the limit goes up', () => {
    const queue = new TaskQueue(1)
    const { started, add } = tasks()
    for (const id of ['a', 'b', 'c']) add(queue, id)
    expect(started).toEqual(['a'])

    queue.setConcurrency(3)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('does not stop anything when the limit goes down', () => {
    const queue = new TaskQueue(3)
    const { started, add } = tasks()
    for (const id of ['a', 'b', 'c', 'd']) add(queue, id)
    expect(started).toEqual(['a', 'b', 'c'])

    queue.setConcurrency(1)
    expect(queue.activeCount).toBe(3)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('waits for the running repairs to drop below the new limit', async () => {
    const queue = new TaskQueue(3)
    const { started, add, finish } = tasks()
    for (const id of ['a', 'b', 'c', 'd']) add(queue, id)
    queue.setConcurrency(1)

    await finish('a')
    expect(started).toEqual(['a', 'b', 'c'])
    await finish('b')
    expect(started).toEqual(['a', 'b', 'c'])

    // Now one is running, which is the new limit — still no room.
    expect(queue.activeCount).toBe(1)
    await finish('c')
    expect(started).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps the limit inside what the queue will accept', () => {
    const queue = new TaskQueue(2)
    const { started, add } = tasks()
    for (const id of ['a', 'b', 'c']) add(queue, id)

    queue.setConcurrency(0)
    expect(queue.activeCount).toBe(2)
    queue.setConcurrency(99)
    expect(started).toEqual(['a', 'b', 'c'])
  })
})

/**
 * Choosing what runs next.
 *
 * A queue of fifty films starts in whatever order the library was walked in,
 * and the one you actually want tonight is somewhere in the middle of it. The
 * order of what has not started is the only part of a queue that is still
 * anyone's to decide.
 */
describe('reordering what is waiting', () => {
  it('starts the one moved to the front first', async () => {
    const queue = new TaskQueue(1)
    const { started, add, finish } = tasks()
    for (const id of ['a', 'b', 'c', 'd']) add(queue, id)

    // 'a' is running; 'b', 'c', 'd' are waiting.
    expect(started).toEqual(['a'])
    expect(queue.pendingIds()).toEqual(['b', 'c', 'd'])

    expect(queue.move('d', -1)).toBe('c')
    expect(queue.move('d', -1)).toBe('b')
    expect(queue.pendingIds()).toEqual(['d', 'b', 'c'])

    await finish('a')
    expect(started).toEqual(['a', 'd'])
  })

  it('says which task changed places, so a caller can follow', () => {
    const queue = new TaskQueue(1)
    const { add } = tasks()
    for (const id of ['a', 'b', 'c']) add(queue, id)

    expect(queue.move('c', -1)).toBe('b')
    expect(queue.pendingIds()).toEqual(['c', 'b'])
    expect(queue.move('c', 1)).toBe('b')
    expect(queue.pendingIds()).toEqual(['b', 'c'])
  })

  it('does nothing at either end of the queue', () => {
    const queue = new TaskQueue(1)
    const { add } = tasks()
    for (const id of ['a', 'b', 'c']) add(queue, id)

    expect(queue.move('b', -1)).toBeUndefined()
    expect(queue.move('c', 1)).toBeUndefined()
    expect(queue.pendingIds()).toEqual(['b', 'c'])
  })

  /**
   * A running repair has a file open and a temporary half written. "Sooner"
   * cannot mean anything to it, and the task it would change places with has
   * not started — moving it would reorder the queue around a task that is not
   * in the queue.
   */
  it('will not move what is already running', () => {
    const queue = new TaskQueue(1)
    const { started, add } = tasks()
    for (const id of ['a', 'b']) add(queue, id)

    expect(started).toEqual(['a'])
    expect(queue.move('a', 1)).toBeUndefined()
    expect(queue.pendingIds()).toEqual(['b'])
  })

  it('does nothing for a task it has never heard of', () => {
    const queue = new TaskQueue(1)
    const { add } = tasks()
    add(queue, 'a')
    expect(queue.move('nobody', -1)).toBeUndefined()
  })

  it('never starts anything by itself', async () => {
    const queue = new TaskQueue(1)
    const { started, add } = tasks()
    for (const id of ['a', 'b', 'c']) add(queue, id)

    queue.move('c', -1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Still one running and two waiting: the order changed, not the limit.
    expect(started).toEqual(['a'])
    expect(queue.activeCount).toBe(1)
    expect(queue.pendingCount).toBe(2)
  })
})
