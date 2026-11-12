/**
 * Reading a repair's measurements back out.
 *
 * The runner records how long each stage took; this turns that into the two
 * things anyone actually wants from it — a line saying what the repair cost,
 * and, when it was slow, a sentence naming what it was waiting on.
 */

import type { JobMetrics, JobPhase, JobPhaseTiming } from './types.js'

export const PHASE_LABEL: Record<JobPhase, string> = {
  'in-place-check': 'Checked for an in-place edit',
  'in-place-edit': 'Edited the header in place',
  ffmpeg: 'ffmpeg',
  finalise: 'Moved the index to the front',
  verify: 'Re-probed the output',
  promote: 'Moved into place',
  subtitles: 'Wrote subtitle sidecars',
  total: 'Total'
}

const MB = 1024 * 1024

/** `62000` -> `1m 2s`; sub-second values keep their milliseconds. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * MB) return `${Math.round(bytes / MB)} MB`
  return `${(bytes / (1024 * MB)).toFixed(2)} GB`
}

export function phase(metrics: JobMetrics | undefined, name: JobPhase): JobPhaseTiming | undefined {
  return metrics?.phases.find((entry) => entry.phase === name)
}

/** How many times faster than playback the repair ran, e.g. `48x realtime`. */
export function realtimeFactor(metrics: JobMetrics): string | undefined {
  const ffmpeg = phase(metrics, 'ffmpeg')
  if (!ffmpeg || !metrics.durationSeconds || ffmpeg.ms <= 0) return undefined
  const factor = metrics.durationSeconds / (ffmpeg.ms / 1000)
  if (!Number.isFinite(factor) || factor <= 0) return undefined
  return `${factor >= 10 ? Math.round(factor) : factor.toFixed(1)}x realtime`
}

/** The one-line cost of a repair, for the row in the queue. */
export function summarizeMetrics(metrics: JobMetrics | undefined): string | undefined {
  if (!metrics) return undefined
  const total = phase(metrics, 'total')
  if (!total) return undefined
  const parts = [formatMs(total.ms)]
  if (metrics.mbPerSecond) parts.push(`${Math.round(metrics.mbPerSecond)} MB/s`)
  const realtime = realtimeFactor(metrics)
  if (realtime) parts.push(realtime)
  return parts.join(' · ')
}

/** Phases worth printing: everything measured, longest first, total last. */
export function rankedPhases(metrics: JobMetrics): JobPhaseTiming[] {
  return metrics.phases
    .filter((entry) => entry.phase !== 'total')
    .slice()
    .sort((a, b) => b.ms - a.ms)
}

/**
 * What was actually slow, in plain words.
 *
 * Each note names a cause the numbers support and nothing more: a reading of
 * 20 MB/s from a network share is the network, the same reading from an
 * internal disk is not, and the two deserve different advice.
 */
export function diagnoseMetrics(metrics: JobMetrics | undefined): string[] {
  if (!metrics) return []
  const notes: string[] = []
  const ffmpeg = phase(metrics, 'ffmpeg')
  const finalise = phase(metrics, 'finalise')
  const promote = phase(metrics, 'promote')
  const total = phase(metrics, 'total')

  if (ffmpeg && metrics.mbPerSecond != null && metrics.mbPerSecond > 0) {
    const rate = Math.round(metrics.mbPerSecond)
    const remote = metrics.source?.kind === 'network' || metrics.output?.kind === 'network'
    if (remote) {
      notes.push(
        `The copy ran at about ${rate} MB/s across a network mount${
          metrics.source?.mount ? ` (${metrics.source.mount})` : ''
        }. A remux reads and writes every byte, so this is the link speed rather than anything PlexFixer decides. ` +
          'Running the repair on the machine that holds the files is the fix that matters here.'
      )
    } else if (rate < 40) {
      notes.push(
        `The copy ran at about ${rate} MB/s, which is slow for a local disk — an external drive over USB 2, ` +
          'a spinning disk, or another process competing for it would all look like this.'
      )
    }
  }

  // The index move is a second pass over the whole file and reports no
  // progress, so it is the stage that most often feels like a hang.
  if (finalise && ffmpeg && finalise.ms > 1500 && finalise.ms > ffmpeg.ms * 0.15) {
    notes.push(
      `Moving the MP4 index to the front took ${formatMs(finalise.ms)} — ${Math.round(
        (finalise.ms / ffmpeg.ms) * 100
      )}% of the ffmpeg run. That is a second pass over the whole file, and it is unavoidable for a file whose ` +
        'index sits at the end.'
    )
  }

  if (promote && promote.ms > 2000) {
    notes.push(
      metrics.sameVolume === false
        ? `Moving the finished file into place took ${formatMs(promote.ms)} because it crossed volumes, which ` +
          'means every byte was copied again. Writing output to the same volume as the source avoids it.'
        : `Moving the finished file into place took ${formatMs(promote.ms)}, which is unusual for a rename on ` +
          'one volume — the backup of the original is the other move in this stage.'
    )
  }

  if (notes.length === 0 && total && ffmpeg && total.ms > 0) {
    const share = Math.round((ffmpeg.ms / total.ms) * 100)
    if (share >= 80) {
      notes.push(
        `${share}% of the time was ffmpeg itself${
          metrics.mbPerSecond ? ` at about ${Math.round(metrics.mbPerSecond)} MB/s` : ''
        }, which is the floor for a repair that copies every byte.`
      )
    }
  }

  return notes
}

/** The measurements as text, for a report or the clipboard. */
export function metricsLines(metrics: JobMetrics): string[] {
  const lines: string[] = []
  const total = phase(metrics, 'total')
  if (total) lines.push(`total          ${formatMs(total.ms)}`)
  if (metrics.sourceBytes) lines.push(`source size    ${formatBytes(metrics.sourceBytes)}`)
  if (metrics.outputBytes) lines.push(`output size    ${formatBytes(metrics.outputBytes)}`)
  if (metrics.mbPerSecond) lines.push(`throughput     ${Math.round(metrics.mbPerSecond)} MB/s`)
  const realtime = realtimeFactor(metrics)
  if (realtime) lines.push(`speed          ${realtime}${metrics.ffmpegSpeed ? ` (ffmpeg said ${metrics.ffmpegSpeed})` : ''}`)
  if (metrics.source) lines.push(`source volume  ${describeVolume(metrics.source)}`)
  if (metrics.output) lines.push(`output volume  ${describeVolume(metrics.output)}`)
  if (metrics.sameVolume === false) lines.push('volumes        output is on a different volume from the source')

  lines.push('', 'Stages:')
  for (const entry of rankedPhases(metrics)) {
    const share = total && total.ms > 0 ? `  ${String(Math.round((entry.ms / total.ms) * 100)).padStart(3)}%` : ''
    const bytes = entry.bytes ? `  ${formatBytes(entry.bytes)}` : ''
    lines.push(`  ${PHASE_LABEL[entry.phase].padEnd(30)} ${formatMs(entry.ms).padStart(8)}${share}${bytes}`)
    if (entry.note) lines.push(`      ${entry.note}`)
  }
  return lines
}

function describeVolume(volume: NonNullable<JobMetrics['source']>): string {
  const bits = [volume.mount ?? '?', volume.filesystem ? `(${volume.filesystem})` : undefined, volume.kind]
  return bits.filter(Boolean).join(' ')
}
