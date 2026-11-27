/**
 * What the queue says about itself.
 *
 * "Nothing is running" has three quite different causes — the queue is held
 * while a batch arrives, every slot is busy, or there is nothing to run — and
 * on screen they look identical. The report has to tell them apart, because
 * the first is a bug and the last two are the queue working.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { TaskQueue } from '../src/shared/plex/queue.js'
import { clearTrace, traceEntries, traceReport } from '../src/shared/trace.js'

beforeEach(() => clearTrace())

const never = (): Promise<void> => new Promise<void>(() => {})
const said = (): string => traceEntries().map((entry) => entry.text).join('\n')

describe('a queue that is not starting anything', () => {
  it('says when it is held, and by how many', () => {
    const queue = new TaskQueue(3)
    const release = queue.hold()
    void queue.add({ id: 'a', run: never })
    void queue.add({ id: 'b', run: never })

    expect(said()).toContain('held by 1 caller still adding a batch')
    // Said once, not once per file: a batch of eighty would otherwise bury
    // the one stretch of log worth reading under eighty copies of it.
    expect(traceEntries().filter((entry) => entry.text.startsWith('nothing is starting'))).toHaveLength(1)
    expect(traceReport().join('\n')).toContain('0 of 3 running, 2 waiting, HELD by 1')
    release()
  })

  it('says when every slot is busy, which is not a fault', () => {
    const queue = new TaskQueue(1)
    void queue.add({ id: 'a', run: never })
    void queue.add({ id: 'b', run: never })
    expect(said()).toContain('the only slot is busy')
  })

  it('says nothing of the sort when there is simply nothing waiting', () => {
    const queue = new TaskQueue(2)
    void queue.add({ id: 'a', run: never })
    expect(said()).not.toContain('and none started')
  })

  it('states where the queue stands, as it stands now', () => {
    const queue = new TaskQueue(2)
    void queue.add({ id: 'a', run: never })
    void queue.add({ id: 'b', run: never })
    void queue.add({ id: 'c', run: never })
    expect(traceReport().join('\n')).toContain('2 of 2 running, 1 waiting')
  })

  it('shows a hold in the state, so a wedged batch is obvious', () => {
    const queue = new TaskQueue(2)
    queue.hold()
    void queue.add({ id: 'a', run: never })
    expect(traceReport().join('\n')).toContain('HELD by 1')
  })
})

describe('what the queue records about each task', () => {
  it('ties a task to the slot it took and the time it took', async () => {
    const queue = new TaskQueue(2)
    await queue.add({ id: 'abcdef12-0000', run: async () => undefined })
    // The caller's promise settles a tick before the queue frees the slot:
    // `add` resolves from inside the task, and the slot is given back in the
    // `finally` that follows it.
    await Promise.resolve()
    await Promise.resolve()
    const text = said()
    expect(text).toContain('added')
    expect(text).toContain('started (1 of 2 now running)')
    expect(text).toContain('finished')
    expect(traceEntries().find((entry) => entry.text === 'finished')?.ref).toBe('abcdef12-0000')
  })

  it('notes a change to how many may run at once', () => {
    const queue = new TaskQueue(2)
    queue.setConcurrency(3)
    expect(said()).toContain('how many run at once: 2 -> 3')
  })

  it('says nothing when the number is set to what it already was', () => {
    const queue = new TaskQueue(3)
    queue.setConcurrency(3)
    expect(said()).not.toContain('how many run at once')
  })
})
