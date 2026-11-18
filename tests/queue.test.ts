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
