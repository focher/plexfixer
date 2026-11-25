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
 * anyone's to decide, and it is decided by dragging a row to a place — not by
 * nudging it one step at a time.
 */
describe('reordering what is waiting', () => {
  it('starts the one moved to the front first', async () => {
    const queue = new TaskQueue(1)
    const { started, add, finish } = tasks()
    for (const id of ['a', 'b', 'c', 'd']) add(queue, id)

    // 'a' is running; 'b', 'c', 'd' are waiting.
    expect(started).toEqual(['a'])
    expect(queue.pendingIds()).toEqual(['b', 'c', 'd'])

    expect(queue.moveTo('d', 0)).toEqual(['d', 'b', 'c'])

    await finish('a')
    expect(started).toEqual(['a', 'd'])
  })

  it('moves a task to any place in one go, in either direction', () => {
    const queue = new TaskQueue(1)
    const { add } = tasks()
    for (const id of ['a', 'b', 'c', 'd', 'e']) add(queue, id)
    expect(queue.pendingIds()).toEqual(['b', 'c', 'd', 'e'])

    // Top to bottom, then bottom to the middle.
    expect(queue.moveTo('b', 3)).toEqual(['c', 'd', 'e', 'b'])
    expect(queue.moveTo('b', 1)).toEqual(['c', 'b', 'd', 'e'])
  })

  /**
   * "Drop it at the bottom" is a gesture, not a measurement. The caller should
   * not have to count the queue to express it, and a queue that shrank while
   * the drag was in the air must not throw the task somewhere surprising.
   */
  it('clamps a place outside the queue to its ends', () => {
    const queue = new TaskQueue(1)
    const { add } = tasks()
    for (const id of ['a', 'b', 'c', 'd']) add(queue, id)

    expect(queue.moveTo('b', 99)).toEqual(['c', 'd', 'b'])
    expect(queue.moveTo('b', -99)).toEqual(['b', 'c', 'd'])
  })

  it('says nothing changed when it is already there', () => {
    const queue = new TaskQueue(1)
    const { add } = tasks()
    for (const id of ['a', 'b', 'c']) add(queue, id)

    expect(queue.moveTo('b', 0)).toBeUndefined()
    expect(queue.moveTo('c', 1)).toBeUndefined()
    expect(queue.pendingIds()).toEqual(['b', 'c'])
  })

  /**
   * A running task has a file open and a temporary half written. "Sooner"
   * cannot mean anything to it, and it is not in the queue to be moved around.
   */
  it('will not move what is already running', () => {
    const queue = new TaskQueue(1)
    const { started, add } = tasks()
    for (const id of ['a', 'b']) add(queue, id)

    expect(started).toEqual(['a'])
    expect(queue.moveTo('a', 1)).toBeUndefined()
    expect(queue.pendingIds()).toEqual(['b'])
  })

  it('does nothing for a task it has never heard of', () => {
    const queue = new TaskQueue(1)
    const { add } = tasks()
    add(queue, 'a')
    expect(queue.moveTo('nobody', 0)).toBeUndefined()
  })

  it('never starts anything by itself', async () => {
    const queue = new TaskQueue(1)
    const { started, add } = tasks()
    for (const id of ['a', 'b', 'c']) add(queue, id)

    queue.moveTo('c', 0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Still one running and two waiting: the order changed, not the limit.
    expect(started).toEqual(['a'])
    expect(queue.activeCount).toBe(1)
    expect(queue.pendingCount).toBe(2)
  })
})
