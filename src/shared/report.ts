/**
 * Building the shareable diagnostic report for a repair.
 *
 * The point is that someone can paste the output somewhere and it answers the
 * obvious follow-up questions on its own: what the file was, what PlexFixer
 * decided and why, the exact ffmpeg command, and what happened step by step.
 * Paths are included verbatim because a report without them is unactionable.
 */

import type {
  AboutInfo,
  AnalysisResult,
  AppSettings,
  EnvironmentInfo,
  Job,
  JobLogEntry,
  MediaFile,
  RepairMode
} from './types.js'
import { buildAboutText } from './about.js'
import { blockedReasons } from './plex/blocked.js'
import { diagnoseMetrics, formatBytes, formatMs, metricsLines, phase, summarizeMetrics } from './metrics.js'

export interface ReportContext {
  job: Job
  /** The analysis the job was built from, when it is still around. */
  result?: AnalysisResult
  environment?: EnvironmentInfo
  appVersion?: string
  platform?: string
}

function section(title: string): string {
  return `\n## ${title}\n`
}

function stamp(entry: JobLogEntry, start: number): string {
  const offset = ((entry.at - start) / 1000).toFixed(1).padStart(6)
  const level = entry.level === 'info' ? '    ' : entry.level === 'warn' ? 'WARN' : 'ERR '
  return `${offset}s ${level} ${entry.text}`
}

function describeFile(file: MediaFile): string {
  const lines = [
    `path       ${file.path}`,
    `container  ${file.formatName} (${file.container})`,
    `size       ${file.sizeBytes} bytes`,
    `duration   ${file.durationSeconds ?? 'unknown'}`,
    file.container === 'mp4' ? `faststart  ${file.faststart ?? 'unknown'}` : undefined,
    '',
    'Streams:'
  ].filter((line): line is string => line != null)

  for (const stream of file.streams) {
    const flags = Object.entries(stream.disposition)
      .filter(([, on]) => on)
      .map(([name]) => name)
    const extra: string[] = []
    if (stream.kind === 'video') {
      extra.push(`${stream.width}x${stream.height}`, stream.pixFmt ?? '', stream.profile ?? '')
      if (stream.codecTag) extra.push(`tag=${stream.codecTag}`)
      if (stream.level) extra.push(`level=${stream.level}`)
    } else if (stream.kind === 'audio') {
      extra.push(`${stream.channels}ch`, stream.channelLayout ?? '', stream.profile ?? '')
    } else if (stream.kind === 'subtitle') {
      extra.push(stream.isImageBased ? 'image-based' : 'text')
    }
    const tail = extra.filter(Boolean).join(' ')
    lines.push(
      `  ${String(stream.index).padEnd(3)} ${stream.kind.padEnd(10)} ${stream.codec.padEnd(14)} ` +
        `${(stream.language || 'und').padEnd(5)} ${tail}${flags.length > 0 ? ` [${flags.join(',')}]` : ''}`
    )
  }
  return lines.join('\n')
}

/** The environment block, shared by both reports. */
function describeEnvironment(environment: EnvironmentInfo): string[] {
  const out = [
    `ffmpeg     ${environment.ffmpegPath ?? 'not found'} (${environment.ffmpegSource ?? 'unknown'})`,
    `ffprobe    ${environment.ffprobePath ?? 'not found'} (${environment.ffprobeSource ?? 'unknown'})`
  ]
  if (environment.ffmpegVersion) out.push(`version    ${environment.ffmpegVersion}`)
  const caps = environment.capabilities
  if (caps) {
    // The four booleans are the verdict after a real test encode; `available`
    // is only what ffmpeg claims to have built in, which is often more.
    const usable = (['nvenc', 'qsv', 'amf', 'videotoolbox'] as const).filter((name) => caps[name])
    out.push(`hw encode  ${usable.length > 0 ? usable.join(', ') : 'none — software only'}`)
    if (caps.available.length > 0) out.push(`ffmpeg has ${caps.available.join(', ')}`)
  }
  return out
}

/** The file, its findings and its plan — the part both reports share. */
function describeAnalysis(result: AnalysisResult): string[] {
  const out: string[] = []

  out.push(section('Source file'))
  out.push(describeFile(result.file))

  out.push(section('Findings'))
  if (result.findings.length === 0) {
    out.push('(none)')
  } else {
    for (const finding of result.findings) {
      out.push(`[${finding.severity}] ${finding.title}  (${finding.code}, remedy: ${finding.remedy})`)
      out.push(`    ${finding.detail}`)
    }
  }

  out.push(section('Plan'))
  out.push(`target container  ${result.plan.targetContainer}`)
  out.push(`cost              ${result.plan.costNote}`)
  if (result.plan.actions.length === 0) out.push('(no actions)')
  for (const action of result.plan.actions) out.push(`• ${action.label} — ${action.detail}`)

  return out
}

/**
 * The settings that shaped the verdict.
 *
 * Only the ones that decide whether a file passes. A report saying a file is
 * clean is not much use without them: "HEVC is fine" and "MKV is the target"
 * are settings, not facts about the file.
 */
function describeSettings(settings: AppSettings): string[] {
  return [
    `target container  ${settings.targetContainer}`,
    `remux MKV to MP4  ${settings.remuxMkvToMp4}`,
    `HEVC compatible   ${settings.allowHevc}`,
    `max H.264 level   ${settings.maxH264Level}`,
    `max height        ${settings.maxHeight}`,
    `ensure AAC       ${settings.ensureAacStereo}`,
    `audio language    ${settings.preferredAudioLanguage} (untagged treated as ${settings.assumeUndefinedIs})`,
    `subtitle language ${settings.preferredSubtitleLanguage}`,
    `extensions        ${settings.mediaExtensions.join(', ')}`
  ]
}

export interface FileReportContext {
  result: AnalysisResult
  environment?: EnvironmentInfo
  settings?: AppSettings
  /** The mode this file would repair in, and where that came from. */
  mode?: RepairMode
  modeSource?: string
  appVersion?: string
  platform?: string
}

/**
 * A diagnostic report for one scanned file, repaired or not.
 *
 * The job report only exists once something has been written. This is the one
 * to reach for when the question is why a file was judged the way it was —
 * above all when it passed and the expectation was that it would not.
 */
export function buildFileReport(context: FileReportContext): string {
  const { result, environment, settings } = context
  const out: string[] = []

  out.push('# PlexFixer file report')
  out.push('')
  out.push(`generated  ${new Date().toISOString()}`)
  if (context.appVersion) out.push(`version    ${context.appVersion}`)
  if (context.platform) out.push(`platform   ${context.platform}`)
  out.push(`verdict    ${result.verdict}`)
  out.push(`strategy   ${result.plan.strategy}`)
  if (context.mode) out.push(`mode       ${context.mode}${context.modeSource ? ` (${context.modeSource})` : ''}`)
  if (result.scannedAt) out.push(`scanned    ${new Date(result.scannedAt).toISOString()}`)
  out.push(`language   ${result.primaryLanguage} (${result.primaryLanguageSource})`)

  if (environment) {
    out.push(section('Environment'))
    out.push(...describeEnvironment(environment))
  }

  if (settings) {
    out.push(section('Settings that decide this'))
    out.push(...describeSettings(settings))
  }

  out.push(...describeAnalysis(result))

  if (result.plan.unresolved.length > 0) {
    out.push(section('Nothing in the plan addresses these'))
    for (const finding of result.plan.unresolved) out.push(`[${finding.severity}] ${finding.title} (${finding.code})`)
  }

  // The same explanation the detail pane shows, so a shared report answers
  // "why will it not fix this?" without the app open beside it.
  const blocked = blockedReasons(result)
  if (blocked.length > 0) {
    out.push(section('Why this file is blocked'))
    for (const reason of blocked) {
      out.push(`${reason.title}`)
      out.push(`    why          ${reason.why}`)
      out.push(`    what you can ${reason.youCan}`)
    }
  }

  return out.join('\n')
}

export function buildJobReport(context: ReportContext): string {
  const { job, result, environment } = context
  const out: string[] = []

  out.push(`# PlexFixer repair report`)
  out.push('')
  out.push(`generated  ${new Date().toISOString()}`)
  if (context.appVersion) out.push(`version    ${context.appVersion}`)
  if (context.platform) out.push(`platform   ${context.platform}`)
  out.push(`state      ${job.state}`)
  out.push(`strategy   ${job.strategy}`)
  out.push(`mode       ${job.mode}`)
  if (job.message) out.push(`message    ${job.message}`)

  if (environment) {
    out.push(section('Environment'))
    out.push(...describeEnvironment(environment))
  }

  if (result) out.push(...describeAnalysis(result))

  if (job.command) {
    out.push(section('Command'))
    out.push(job.command.map((part) => (/[\s"'$`\\]/.test(part) ? JSON.stringify(part) : part)).join(' '))
  }

  if (job.metrics) {
    out.push(section('Performance'))
    out.push(...metricsLines(job.metrics))
    const notes = diagnoseMetrics(job.metrics)
    if (notes.length > 0) {
      out.push('', 'What that points at:')
      for (const note of notes) out.push(`  • ${note}`)
    }
  }

  out.push(section('Log'))
  const start = job.log[0]?.at ?? job.startedAt ?? Date.now()
  if (job.log.length === 0) {
    out.push('(no steps recorded)')
  } else {
    for (const entry of job.log) {
      out.push(stamp(entry, start))
      if (entry.detail) {
        for (const line of entry.detail.split('\n')) out.push(`         ${line}`)
      }
    }
  }

  return out.join('\n')
}

/* ------------------------------------------------------------------ *
 * Whole-app diagnostics
 * ------------------------------------------------------------------ */

export interface DiagnosticsContext {
  about?: AboutInfo
  environment?: EnvironmentInfo
  settings?: AppSettings
  /** Every job this session knows about; finished ones carry measurements. */
  jobs: Job[]
  /** The analysis of each job's source, where the library still holds it. */
  resultsByPath?: Map<string, AnalysisResult>
  /** How the scanned library breaks down, for context on what was repaired. */
  library?: { total: number; passed: number; fixable: number; reencode: number; blocked: number }
  platform?: string
}

/** The settings that decide how fast a repair runs, rather than what it does. */
function describePerformanceSettings(settings: AppSettings): string[] {
  return [
    `concurrency       ${settings.concurrency}`,
    `output placement  ${settings.outputPlacement}${
      settings.outputPlacement === 'output-dir' ? ` -> ${settings.outputDirectory || '(not set)'}` : ''
    }`,
    `keep backups      ${settings.keepBackups}`,
    `target container  ${settings.targetContainer} (remux MKV to MP4: ${settings.remuxMkvToMp4})`,
    `extract subs      ${settings.extractTextSubtitles}`,
    `hardware encoder  ${settings.hardwareEncoder}`,
    `transcode codec   ${settings.transcodeVideoCodec} @ quality ${settings.videoQuality}`
  ]
}

/**
 * Everything needed to answer "why was that slow?" from outside the machine.
 *
 * Deliberately one plain-text block: it is meant to be pasted into a message,
 * so it carries the build, the settings that shape a repair's cost, and the
 * measurements of what actually ran — not a log file someone has to go and
 * find.
 */
export function buildDiagnosticsReport(context: DiagnosticsContext): string {
  const { about, environment, settings, jobs } = context
  const out: string[] = []

  out.push('# PlexFixer diagnostics')
  out.push('')
  out.push(`generated  ${new Date().toISOString()}`)
  if (context.platform) out.push(`platform   ${context.platform}`)
  if (about) {
    out.push('')
    out.push(buildAboutText(about, environment))
  } else if (environment) {
    out.push(section('Environment'))
    out.push(...describeEnvironment(environment))
  }

  if (settings) {
    out.push(section('Settings that decide repair cost'))
    out.push(...describePerformanceSettings(settings))
    out.push(section('Settings that decide the verdict'))
    out.push(...describeSettings(settings))
  }

  if (context.library) {
    const { total, passed, fixable, reencode, blocked } = context.library
    out.push(section('Library'))
    out.push(`scanned    ${total}`)
    out.push(`passed     ${passed}`)
    out.push(`fixable    ${fixable}`)
    out.push(`re-encode  ${reencode}`)
    out.push(`blocked    ${blocked}`)
  }

  const measured = jobs.filter((job) => job.metrics && phase(job.metrics, 'total'))
  out.push(section(`Repairs (${jobs.length}, ${measured.length} measured)`))
  if (jobs.length === 0) out.push('(nothing has been repaired in this session)')

  // Most recent first: the repair someone is asking about is the last one run.
  const ordered = [...jobs].sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0))
  for (const job of ordered.slice(0, 25)) {
    const result = context.resultsByPath?.get(job.sourcePath)
    out.push('')
    out.push(`• ${job.sourcePath}`)
    out.push(`  ${job.state} · ${job.strategy} · mode ${job.mode}${job.message ? ` · ${job.message}` : ''}`)
    if (result) {
      out.push(
        `  ${result.file.formatName} · ${formatBytes(result.file.sizeBytes)} · ` +
          `${Math.round(result.file.durationSeconds ?? 0)}s · ${result.plan.costNote}`
      )
    }
    if (job.metrics) {
      const summary = summarizeMetrics(job.metrics)
      if (summary) out.push(`  ${summary}`)
      for (const line of metricsLines(job.metrics)) out.push(`  ${line}`)
      for (const note of diagnoseMetrics(job.metrics)) out.push(`  → ${note}`)
    }
    // A failure is the one case where the steps matter more than the timings.
    if (job.state === 'failed') {
      out.push('  Last steps:')
      for (const entry of job.log.slice(-8)) {
        out.push(`    ${entry.level === 'info' ? ' ' : entry.level === 'warn' ? '!' : 'x'} ${entry.text}`)
        if (entry.detail) for (const line of entry.detail.split('\n').slice(0, 6)) out.push(`        ${line}`)
      }
    }
  }

  const throughputs = measured
    .map((job) => job.metrics?.mbPerSecond)
    .filter((rate): rate is number => typeof rate === 'number' && rate > 0)
  if (throughputs.length > 1) {
    const sorted = [...throughputs].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    out.push(section('Across this session'))
    out.push(`repairs measured  ${throughputs.length}`)
    out.push(`median throughput ${Math.round(median)} MB/s`)
    out.push(`slowest / fastest ${Math.round(sorted[0] ?? 0)} / ${Math.round(sorted[sorted.length - 1] ?? 0)} MB/s`)
    const slowest = measured
      .slice()
      .sort((a, b) => (phase(b.metrics!, 'total')?.ms ?? 0) - (phase(a.metrics!, 'total')?.ms ?? 0))[0]
    if (slowest) {
      out.push(`longest repair    ${formatMs(phase(slowest.metrics!, 'total')?.ms ?? 0)} — ${slowest.sourcePath}`)
    }
  }

  return out.join('\n')
}
