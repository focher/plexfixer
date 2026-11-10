/**
 * Building the shareable diagnostic report for a repair.
 *
 * The point is that someone can paste the output somewhere and it answers the
 * obvious follow-up questions on its own: what the file was, what PlexFixer
 * decided and why, the exact ffmpeg command, and what happened step by step.
 * Paths are included verbatim because a report without them is unactionable.
 */

import type { AnalysisResult, EnvironmentInfo, Job, JobLogEntry, MediaFile } from './types.js'

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
    out.push(`ffmpeg     ${environment.ffmpegPath ?? 'not found'} (${environment.ffmpegSource ?? 'unknown'})`)
    out.push(`ffprobe    ${environment.ffprobePath ?? 'not found'} (${environment.ffprobeSource ?? 'unknown'})`)
    if (environment.ffmpegVersion) out.push(`version    ${environment.ffmpegVersion}`)
    const caps = environment.capabilities
    if (caps) {
      // The four booleans are the verdict after a real test encode; `available`
      // is only what ffmpeg claims to have built in, which is often more.
      const usable = (['nvenc', 'qsv', 'amf', 'videotoolbox'] as const).filter((name) => caps[name])
      out.push(`hw encode  ${usable.length > 0 ? usable.join(', ') : 'none — software only'}`)
      if (caps.available.length > 0) out.push(`ffmpeg has ${caps.available.join(', ')}`)
    }
  }

  if (result) {
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
  }

  if (job.command) {
    out.push(section('Command'))
    out.push(job.command.map((part) => (/[\s"'$`\\]/.test(part) ? JSON.stringify(part) : part)).join(' '))
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
