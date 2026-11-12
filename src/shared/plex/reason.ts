/**
 * Condenses an analysis down to the one phrase the results table has room for:
 * why this file is not Plex-ready, and whether anything automatic will fix it.
 *
 * The full findings list is the real story and stays in the detail pane. The
 * table needs a single line, so this picks the finding that actually drives the
 * outcome — the most severe one, preferring a finding the repair plan cannot
 * resolve, since that is what the user has to decide about.
 */

import type { AnalysisResult, Finding, Severity } from '../types.js'
import { blockingFindings } from './blocked.js'

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, warning: 1, info: 2 }

const SEVERITY_WORD: Record<Severity, string> = {
  blocker: 'blocker',
  warning: 'warning',
  info: 'note'
}

export type ReasonTone =
  /** Nothing to fix — it already direct plays. */
  | 'ok'
  /** The default plan resolves it with a stream copy (or an added AAC track). */
  | 'fix'
  /** Only a video re-encode fixes it, so the file needs Force transcode. */
  | 'transcode'
  /** No plan resolves it; the user has to decide what to do. */
  | 'manual'

export interface ReasonSummary {
  tone: ReasonTone
  /** One-line headline naming the problem, for the table cell. */
  headline: string
  /** Findings beyond the headline one, for a "+N more" hint. */
  others: number
  /** Short phrase for what happens about it, e.g. "fixed by remux". */
  outcome: string
  /** Every finding plus the plan's limits, one per line, for the tooltip. */
  detail: string
}

/**
 * Most severe first; among equally severe findings, the ones the plan leaves
 * unresolved come first, because an unfixable warning matters more to the user
 * than a warning that the repair will quietly take care of.
 */
function rank(findings: Finding[], unresolved: Set<Finding>): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const severity = SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity]
      if (severity !== 0) return severity
      const stuck = Number(unresolved.has(b.finding)) - Number(unresolved.has(a.finding))
      if (stuck !== 0) return stuck
      return a.index - b.index
    })
    .map((entry) => entry.finding)
}

export function summarizeReason(result: AnalysisResult): ReasonSummary {
  const { findings, plan } = result
  const unresolved = new Set(plan.unresolved)

  if (findings.length === 0) {
    return {
      tone: 'ok',
      headline: 'Direct plays as-is',
      others: 0,
      outcome: 'nothing to do',
      detail: 'Every stream, the container and the track flags are already in Plex’s safe set.'
    }
  }

  // The same rule as the Status column (see `needsYou`). Info notes are choices
  // the plan made on purpose — "the container stays MKV because a lossless
  // audio track cannot live in MP4" — and a warning only a re-encode would
  // clear is advisory; neither is a file anyone has to go and fix.
  const blocking = blockingFindings(result)

  const tone: ReasonTone =
    blocking.length > 0
      ? 'manual'
      : plan.requiresTranscode
        ? 'transcode'
        : plan.strategy === 'none'
          ? 'ok'
          : 'fix'

  // On a blocked file the headline is what is blocking it. A fixed-by-the-plan
  // blocker can be more severe than the thing the user has to decide about —
  // and leading with a problem the repair already handles buries the one it
  // does not.
  const lead = blocking.length > 0 ? rank(blocking, unresolved)[0] : rank(findings, unresolved)[0]

  return {
    tone,
    headline: lead.title,
    others: findings.length - 1,
    outcome: outcomeFor(tone, result),
    detail: detailFor(result, unresolved)
  }
}

function outcomeFor(tone: ReasonTone, result: AnalysisResult): string {
  if (tone === 'manual') return 'no automatic fix'
  if (tone === 'transcode') return 'needs Force transcode'
  if (tone === 'ok') return 'nothing to do'
  return result.plan.strategy === 'transcode-audio' ? 'fixed by remux + AAC' : 'fixed by remux'
}

function detailFor(result: AnalysisResult, unresolved: Set<Finding>): string {
  const lines = rank(result.findings, unresolved).map((finding) => {
    const stuck = unresolved.has(finding) ? '  — not fixed by the plan' : ''
    return `${SEVERITY_WORD[finding.severity]} · ${finding.title}${stuck}\n    ${finding.detail}`
  })

  if (result.plan.requiresTranscode) {
    lines.push('\nSet this file or its folder to Force transcode to re-encode the video.')
  }
  return lines.join('\n')
}
