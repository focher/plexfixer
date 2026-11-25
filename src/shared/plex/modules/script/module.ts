/**
 * Turning a script someone typed into a module like any other.
 *
 * The point of doing it this way round — a script becomes a `CheckModule`,
 * rather than the engine learning about scripts — is that nothing downstream
 * has to know the difference. A hand-written rule appears in the same list,
 * runs in the same pass, can be switched off the same way, and its findings go
 * through exactly the same handling as a built-in one's.
 */

import type { AppSettings, Finding, RemedyClass } from '../../../types.js'
import type { CheckModule, ScanSignals, UserRequest } from '../framework.js'
import { describeScript } from './describe.js'
import { evaluateScript } from './evaluate.js'
import { parseScript, type ParsedScript, type ScriptProblem } from './parse.js'

/** A rule as Settings knows it: the text, and what reading it produced. */
export interface UserModule {
  id: string
  script: string
  /** Absent when the script does not parse. */
  module?: CheckModule
  /** What is wrong with it, if anything. */
  problems: ScriptProblem[]
  /** The name to show for a rule too broken to have one. */
  title: string
}

/**
 * How much the rule is asking for, which is what the finding should admit to.
 *
 * A rule that asks for a re-encode has to be marked as needing one, or the
 * safe-remux pass would list it as fixed and then not fix it.
 */
function remedyFor(script: ParsedScript): RemedyClass {
  if (script.fixes.includes('transcode-video')) return 'transcode'
  return script.fixes.length > 0 ? 'lossless' : 'manual'
}

export function moduleFromScript(id: string, script: ParsedScript): CheckModule {
  const prose = describeScript(script)
  const remedy = remedyFor(script)

  return {
    id,
    source: 'custom',
    title: script.name,
    summary: prose.summary,
    whatItDoes: prose.whatItDoes,
    howItWorks: prose.howItWorks,
    ifDisabled: prose.ifDisabled,
    raises: script.report ? ['custom'] : [],

    run(context) {
      const match = evaluateScript(script, context)
      if (!match.matched) return {}

      const findings: Finding[] = []
      if (script.report) {
        findings.push({
          code: 'custom',
          severity: script.report.severity,
          remedy,
          title: script.report.title,
          detail: script.report.detail,
          streamIndexes: match.streamIndexes.length > 0 ? match.streamIndexes : undefined
        })
      }

      const signals: ScanSignals = {}
      const requests: UserRequest[] = []

      for (const fix of script.fixes) {
        if (fix === 'transcode-video') {
          signals.needsTranscode = true
          continue
        }
        if (fix === 'remux') {
          requests.push({ module: script.name, kind: 'rewrite', streamIndexes: [] })
          continue
        }
        if (fix === 'drop-track') {
          // Never the video: a rule asking to drop "the track it matched" has
          // matched audio or subtitles, which the parser has already insisted
          // on, and dropping the picture is not a repair.
          const indexes = [...match.byScope.audio, ...match.byScope.subtitle].sort((a, b) => a - b)
          if (indexes.length > 0) requests.push({ module: script.name, kind: 'drop', streamIndexes: indexes })
          continue
        }
        // Retiming joins the list the built-in repair already measures, rather
        // than opening a second route to the same work.
        const wanted = new Set(match.byScope.subtitle)
        const streams = context.subtitles.filter((stream) => wanted.has(stream.index))
        if (streams.length > 0) signals.resyncSubtitles = streams
      }

      if (requests.length > 0) signals.userRequests = requests
      return { findings, signals: Object.keys(signals).length > 0 ? signals : undefined }
    }
  }
}

/**
 * Reading a script costs nothing next to probing a file, but a library scan
 * analyses thousands of files against the same handful of rules — so the
 * reading is kept, keyed by the text itself. Edit the script and the key
 * changes, which is the whole of the invalidation.
 */
const cache = new Map<string, UserModule>()

export function readUserModule(record: { id: string; script: string }): UserModule {
  const key = `${record.id}\u0000${record.script}`
  const hit = cache.get(key)
  if (hit) return hit

  const { script, problems } = parseScript(record.script)
  const title = script?.name || firstName(record.script) || 'Unnamed rule'
  const read: UserModule = {
    id: record.id,
    script: record.script,
    module: script ? moduleFromScript(record.id, script) : undefined,
    problems,
    title
  }

  // A library's worth of scans only ever has a few scripts in flight; this is
  // a cap against an editor keystroke-by-keystroke, not a cache policy.
  if (cache.size > 64) cache.clear()
  cache.set(key, read)
  return read
}

/** The name out of a script that would not parse, so a broken rule is still findable. */
function firstName(source: string): string | undefined {
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*name\s+(.+?)\s*$/i.exec(line)
    if (match) return match[1].replace(/^"|"$/g, '')
  }
  return undefined
}

export function readUserModules(settings: AppSettings): UserModule[] {
  return settings.userModules.map(readUserModule)
}

/** Just the ones that run. */
export function userCheckModules(settings: AppSettings): CheckModule[] {
  return readUserModules(settings)
    .map((read) => read.module)
    .filter((module): module is CheckModule => module !== undefined)
}

/**
 * An id for a new rule.
 *
 * Derived from the name so it is recognisable in the settings file, and given
 * a number when that name is already taken. Once made it never changes, even
 * if the rule is renamed: the id is what "switched off" is remembered against.
 */
export function newUserModuleId(name: string, taken: readonly string[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'rule'

  let candidate = `user.${slug}`
  let suffix = 2
  while (taken.includes(candidate)) {
    candidate = `user.${slug}-${suffix}`
    suffix++
  }
  return candidate
}
