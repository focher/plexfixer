/**
 * A running account of what the app actually did, kept for the report.
 *
 * The job log says what a repair meant to do. This says what it *did*: every
 * call across the bridge, how long it took, and — the part that matters most —
 * which calls started and never came back. A queue that looks stuck is either
 * waiting for a slot or waiting on one call, and nothing on screen tells those
 * apart. A list of what is still in flight does, in one line.
 *
 * Deliberately a module-level ring rather than something passed around: it is
 * written from the queue, the runner and the bridge, and threading a sink
 * through all three would be a larger change than the thing being diagnosed.
 * It holds the last few thousand entries and forgets the rest, so leaving it
 * on costs a bounded amount of memory and no disk.
 *
 * Everything written here is on its way to a clipboard, so the one rule is
 * that a secret never reaches it. `redact` is applied to every value, and the
 * callers that handle credentials hand over an already-trimmed description.
 */

export type TraceArea = 'app' | 'batch' | 'queue' | 'job' | 'ipc' | 'proc' | 'net' | 'scan'

export interface TraceEntry {
  /** Wall clock, so an entry lines up with what someone saw on screen. */
  at: number
  area: TraceArea
  text: string
  /** The job, request or batch this belongs to, when there is one. */
  ref?: string
  /** How long it took, for anything measured. */
  ms?: number
  outcome?: 'ok' | 'failed'
  detail?: string
}

/** One call that has started and not yet come back. */
export interface TraceInFlight {
  area: TraceArea
  text: string
  ref?: string
  since: number
}

/**
 * How much is kept.
 *
 * A long repair is quiet — ffmpeg progress is not traced — so the busy part is
 * scanning and queueing, where a few thousand entries is several minutes of
 * everything. Older entries go first and are counted, so a truncated report
 * says so rather than looking complete.
 */
const CAPACITY = 4000
/** Removed in batches: shifting one at a time off a 4000-long array is not free. */
const FORGET_AT_ONCE = 512

let entries: TraceEntry[] = []
let dropped = 0
let nextToken = 1
const flight = new Map<number, TraceInFlight>()
const facts = new Map<string, string>()

/** Started when the module is first touched, which is near enough to launch. */
const startedAt = Date.now()

/**
 * Keys whose values never reach the log.
 *
 * Matched on the key rather than the value, because an API key looks like any
 * other string. The report is meant to be pasted into a bug thread, and one
 * that quietly carries a Radarr key is worse than no report at all.
 */
const SECRET = /key|token|password|secret|credential|authorization|cookie/i

/** What a value is worth saying, with anything secret taken out. */
export function redact(key: string, value: unknown): string {
  if (SECRET.test(key)) return value == null || value === '' ? '(unset)' : '(hidden)'
  if (value == null) return ''
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length} items]`
  return '{…}'
}

/**
 * A URL with its query thrown away.
 *
 * Every service here takes its API key either in a header or in the query
 * string, so the query is the one part of a URL that cannot be logged. The
 * path is what identifies the call and is kept.
 */
export function safeUrl(url: string): string {
  const cut = url.indexOf('?')
  return cut < 0 ? url : `${url.slice(0, cut)}?…`
}

export function trace(
  area: TraceArea,
  text: string,
  extra?: { ref?: string; ms?: number; outcome?: 'ok' | 'failed'; detail?: string }
): void {
  entries.push({ at: Date.now(), area, text, ...extra })
  if (entries.length > CAPACITY) {
    entries = entries.slice(FORGET_AT_ONCE)
    dropped += FORGET_AT_ONCE
  }
}

/**
 * Note that something has started, and hand back the way to say it finished.
 *
 * Both halves are written. A single entry on completion would be tidier and
 * would also lose the only case worth having this for: a call that never
 * finishes writes nothing at all, and the report would show a gap rather than
 * a hang.
 */
export function begin(
  area: TraceArea,
  text: string,
  options?: {
    ref?: string
    /**
     * Leave out the "started" line for something that happens constantly.
     *
     * The call is still registered as in flight and still timed, so one that
     * hangs is still reported and the totals are still right; all that goes is
     * a line per call in the history, which for a range read is most of it.
     */
    quiet?: boolean
  }
): (outcome?: { failed?: unknown; detail?: string }) => void {
  const ref = options?.ref
  const token = nextToken++
  const since = Date.now()
  flight.set(token, { area, text, ref, since })
  if (!options?.quiet) trace(area, `${text} …`, { ref })
  let ended = false
  return (outcome) => {
    if (ended) return
    ended = true
    flight.delete(token)
    const failed = outcome?.failed
    trace(area, text, {
      ref,
      ms: Date.now() - since,
      outcome: failed === undefined ? 'ok' : 'failed',
      detail: failed === undefined ? outcome?.detail : describeError(failed)
    })
  }
}

/** The same, wrapped around a promise. */
export async function timed<T>(area: TraceArea, text: string, run: () => Promise<T>, ref?: string): Promise<T> {
  const done = begin(area, text, { ref })
  try {
    const value = await run()
    done()
    return value
  } catch (error) {
    done({ failed: error })
    throw error
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * A standing fact about the app, overwritten each time it changes.
 *
 * For the things a log of events describes badly: how many repairs may run at
 * once, how many are running now, whether the queue is held. These are states
 * rather than events, and the question is always what they are *now*.
 */
export function setFact(key: string, value: string): void {
  facts.set(key, value)
}

export function traceEntries(): TraceEntry[] {
  return entries
}

export function traceInFlight(): TraceInFlight[] {
  return [...flight.values()].sort((a, b) => a.since - b.since)
}

export function traceFacts(): [string, string][] {
  return [...facts.entries()]
}

export function traceDropped(): number {
  return dropped
}

/** For tests, and for a "start again" button if one is ever wanted. */
export function clearTrace(): void {
  entries = []
  dropped = 0
  flight.clear()
  facts.clear()
}

function clock(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * A reference short enough to sit on every line.
 *
 * Job ids are UUIDs, and thirty-six characters repeated down a thousand lines
 * is most of the width of the log. The first eight are unique within a run and
 * still line up across the queue, the runner and the bridge.
 */
export function shortRef(ref: string): string {
  return ref.length > 12 ? ref.slice(0, 8) : ref
}

function line(entry: TraceEntry): string {
  const mark = entry.outcome === 'failed' ? 'x' : ' '
  const ref = entry.ref ? ` [${shortRef(entry.ref)}]` : ''
  const took = entry.ms == null ? '' : `  ${duration(entry.ms)}`
  const detail = entry.detail ? `  — ${entry.detail.split('\n')[0]}` : ''
  return `${clock(entry.at)} ${mark} ${entry.area.padEnd(5)}${ref} ${entry.text}${took}${detail}`
}

/**
 * The whole account, in the order it happened, with what is still waiting
 * first.
 *
 * In flight comes first on purpose. It is the answer to "why has nothing
 * moved", and burying it under a thousand lines of history would mean reading
 * the history to find it.
 */
export function traceReport(now = Date.now(), limit = 1200): string[] {
  const out: string[] = []

  const facts = traceFacts()
  if (facts.length > 0) {
    out.push('State right now:')
    for (const [key, value] of facts) out.push(`  ${key.padEnd(18)} ${value}`)
    out.push('')
  }

  const waiting = traceInFlight()
  out.push(`Started and not finished (${waiting.length}):`)
  if (waiting.length === 0) {
    out.push('  (nothing — every call came back)')
  } else {
    for (const item of waiting) {
      out.push(
        `  ${duration(now - item.since).padStart(7)} ago  ${item.area}${item.ref ? ` [${shortRef(item.ref)}]` : ''} ${item.text}`
      )
    }
    out.push('')
    out.push('  Anything here for more than a few seconds is where the app is stuck.')
  }
  out.push('')

  const shown = entries.slice(-limit)
  const missing = dropped + (entries.length - shown.length)
  out.push(`Activity (${shown.length} entries${missing > 0 ? `, ${missing} older ones forgotten` : ''}):`)
  if (shown.length === 0) out.push('  (nothing recorded)')
  for (const entry of shown) out.push(line(entry))

  out.push('')
  out.push(`trace started ${clock(startedAt)}`)
  return out
}

/**
 * The slowest calls of each kind, which is what a shared drive shows up in.
 *
 * A thousand 40ms reads is not a line anyone reads as a problem; "host_read_range
 * ×1420, 58s in total" is.
 */
/**
 * The kind of a thing, without the particular file it was done to.
 *
 * A thousand reads of a thousand different files are one row here, not a
 * thousand — which is the only way "the share is slow" shows up as a line
 * anyone reads as a problem. A command is named by its first word, because
 * everything after it is arguments; anything else drops the tokens that look
 * like a path or a file name and keeps the words.
 */
function groupOf(entry: TraceEntry): string {
  const text = entry.text
  if (entry.area === 'ipc' || entry.area === 'proc') return text.split(' ')[0] ?? text
  const words = text
    .split(' ')
    .filter((word) => !word.includes('/') && !word.includes('\\') && !/\.[a-z0-9]{2,4}$/i.test(word))
    .join(' ')
  return (words || text).slice(0, 44)
}

export function traceTotals(): string[] {
  const totals = new Map<string, { count: number; ms: number; worst: number; failed: number }>()
  for (const entry of entries) {
    if (entry.ms == null) continue
    const key = `${entry.area} ${groupOf(entry)}`
    const row = totals.get(key) ?? { count: 0, ms: 0, worst: 0, failed: 0 }
    row.count += 1
    row.ms += entry.ms
    row.worst = Math.max(row.worst, entry.ms)
    if (entry.outcome === 'failed') row.failed += 1
    totals.set(key, row)
  }

  const ordered = [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)
  if (ordered.length === 0) return ['(nothing measured)']
  return [
    'call                                   count      total     worst  failed',
    ...ordered.map(
      ([key, row]) =>
        `${key.slice(0, 36).padEnd(36)} ${String(row.count).padStart(7)} ${duration(row.ms).padStart(10)} ` +
        `${duration(row.worst).padStart(9)} ${String(row.failed).padStart(7)}`
    )
  ]
}
