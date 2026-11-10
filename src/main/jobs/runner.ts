/**
 * Executing repair plans.
 *
 * Each job writes to a temporary file beside its destination and is only
 * promoted into place after ffmpeg exits cleanly *and* the result re-probes
 * successfully. A failed or cancelled job leaves the original untouched.
 */

import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AnalysisResult,
  AppSettings,
  EncoderCapabilities,
  Job,
  JobLogLevel,
  RepairMode
} from '@shared/types.js'
import { FfmpegError, runFfmpeg } from '../ffmpeg/run.js'
import { probeFile } from '../ffmpeg/probe.js'
import { buildRepairCommand, buildSubtitleExtractCommands } from './command.js'
import { discardTemporary, promoteOutput, resolveOutputPath, temporaryPathFor } from './output.js'
import { TaskQueue } from './queue.js'

export interface RunnerBinaries {
  ffmpegPath: string
  ffprobePath: string
}

export interface EnqueueOptions {
  result: AnalysisResult
  settings: AppSettings
  mode: RepairMode
  caps?: EncoderCapabilities
  scanRoot?: string
}

export type JobListener = (job: Job) => void

export class RepairRunner {
  private readonly queue: TaskQueue
  private readonly jobs = new Map<string, Job>()

  constructor(
    private binaries: RunnerBinaries,
    concurrency: number,
    private readonly onUpdate: JobListener
  ) {
    this.queue = new TaskQueue(concurrency)
  }

  setBinaries(binaries: RunnerBinaries): void {
    this.binaries = binaries
  }

  setConcurrency(value: number): void {
    this.queue.setConcurrency(value)
  }

  list(): Job[] {
    return [...this.jobs.values()]
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    const cancelled = this.queue.cancel(id)
    if (cancelled && job && job.state === 'queued') {
      this.update({ ...job, state: 'cancelled', message: 'Cancelled before starting', finishedAt: Date.now() })
    }
    return cancelled
  }

  cancelAll(): void {
    this.queue.cancelAll()
    for (const job of this.jobs.values()) {
      if (job.state === 'queued') {
        this.update({ ...job, state: 'cancelled', message: 'Cancelled before starting', finishedAt: Date.now() })
      }
    }
  }

  clearFinished(): void {
    for (const [id, job] of this.jobs) {
      if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled' || job.state === 'skipped') {
        this.jobs.delete(id)
      }
    }
  }

  private update(job: Job): void {
    this.jobs.set(job.id, job)
    this.onUpdate(job)
  }

  /**
   * Append one step to a job's log and push the update.
   *
   * The log is the job's own account of what happened, kept so a failure can be
   * shared without asking anyone to reproduce it with a console attached.
   */
  private log(id: string, level: JobLogLevel, text: string, detail?: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.update({ ...job, log: [...job.log, { at: Date.now(), level, text, detail }] })
  }

  /**
   * Queue a repair.
   *
   * Returns the job immediately; progress arrives through the listener. A plan
   * that needs a video re-encode is *skipped* unless the resolved mode for that
   * file is `force-transcode`, which is what keeps "safe remux" safe.
   */
  enqueue(options: EnqueueOptions): Job {
    const { result, settings, mode, scanRoot } = options
    const id = randomUUID()
    const outputPath = resolveOutputPath(result.file.path, result.plan.targetContainer, settings, scanRoot)

    const base: Job = {
      id,
      sourcePath: result.file.path,
      outputPath,
      strategy: result.plan.strategy,
      mode,
      state: 'queued',
      progress: { fraction: 0 },
      log: [
        {
          at: Date.now(),
          level: 'info',
          text: `Queued ${describeStrategy(result.plan.strategy)}`,
          detail:
            `source     ${result.file.path}\n` +
            `target     ${outputPath}\n` +
            `container  ${result.file.container} -> ${result.plan.targetContainer}\n` +
            `mode       ${mode}\n` +
            `plan       ${result.plan.costNote}`
        }
      ]
    }

    if (mode === 'report') {
      const job: Job = {
        ...base,
        state: 'skipped',
        message: 'Report-only mode — nothing was written',
        log: [...base.log, { at: Date.now(), level: 'info', text: 'Skipped: report-only mode' }]
      }
      this.update(job)
      return job
    }

    if (result.plan.strategy === 'none') {
      const job: Job = {
        ...base,
        state: 'skipped',
        message: 'Already Plex-ready — nothing to change',
        log: [...base.log, { at: Date.now(), level: 'info', text: 'Skipped: already Plex-ready' }]
      }
      this.update(job)
      return job
    }

    if (result.plan.requiresTranscode && mode !== 'force-transcode') {
      const job: Job = {
        ...base,
        state: 'skipped',
        message: 'Needs a video re-encode, which safe remux will not do. Set this file or folder to Force transcode.',
        log: [
          ...base.log,
          {
            at: Date.now(),
            level: 'warn',
            text: 'Skipped: needs a video re-encode',
            detail:
              `mode is "${mode}", which only does lossless work.\n` +
              'Set this file or its folder to Force transcode to allow the re-encode.'
          }
        ]
      }
      this.update(job)
      return job
    }

    this.update(base)

    void this.queue.add({
      id,
      run: async (signal) => {
        await this.execute(id, options, outputPath, signal)
      }
    })

    return base
  }

  private async execute(
    id: string,
    options: EnqueueOptions,
    outputPath: string,
    signal: AbortSignal
  ): Promise<void> {
    const { result, settings, caps } = options
    const current = this.jobs.get(id)
    if (!current) return

    const { args, encoderLabel } = buildRepairCommand({ result, settings, caps, outputPath })
    const temporaryPath = temporaryPathFor(outputPath)
    // ffmpeg infers the container from the extension, and the temporary name
    // keeps it, so no explicit -f is needed.
    const finalArgs = args.map((arg) => (arg === outputPath ? temporaryPath : arg))

    this.update({
      ...current,
      state: 'running',
      startedAt: Date.now(),
      command: [this.binaries.ffmpegPath, ...finalArgs],
      message: encoderLabel ? `Encoding with ${encoderLabel}` : undefined
    })

    this.log(id, 'info', 'Planned actions', describePlan(result))
    this.log(
      id,
      'info',
      encoderLabel ? `Running ffmpeg (${encoderLabel})` : 'Running ffmpeg (stream copy)',
      quoteCommand([this.binaries.ffmpegPath, ...finalArgs])
    )
    this.log(id, 'info', 'Writing to a temporary file first', temporaryPath)

    try {
      await runFfmpeg({
        ffmpegPath: this.binaries.ffmpegPath,
        args: finalArgs,
        durationSeconds: result.file.durationSeconds,
        signal,
        onProgress: (progress) => {
          const job = this.jobs.get(id)
          if (!job || job.state !== 'running') return
          this.update({ ...job, progress })
        }
      })

      if (signal.aborted) throw new Error('Cancelled')
      this.log(id, 'info', 'ffmpeg finished cleanly')

      // Confirm the output is a readable media file with the streams we asked
      // for. ffmpeg can exit 0 having produced something unplayable.
      const probed = await probeFile(temporaryPath, { ffprobePath: this.binaries.ffprobePath, includeSidecars: false })
      const hasVideo = probed.streams.some((s) => s.kind === 'video')
      const hasAudio = probed.streams.some((s) => s.kind === 'audio')
      const sourceHadAudio = result.file.streams.some((s) => s.kind === 'audio')
      this.log(id, 'info', 'Re-probed the output', describeStreams(probed));
      if (!hasVideo || (sourceHadAudio && !hasAudio)) {
        throw new Error('The repaired file is missing streams — the original has been left untouched.')
      }

      const { finalPath, backupPath } = await promoteOutput(
        temporaryPath,
        outputPath,
        result.file.path,
        settings
      )
      this.log(
        id,
        'info',
        backupPath ? 'Replaced the original (backed up first)' : 'Replaced the original',
        backupPath ? `now        ${finalPath}\noriginal   ${backupPath}` : `now        ${finalPath}`
      )

      // Sidecar subtitles are written next to the finished file, named so Plex
      // picks them up automatically.
      const extracted = await this.extractSubtitles(result, finalPath, signal, id)

      const notes: string[] = []
      if (backupPath) notes.push(`original kept in ${join(BACKUP_LABEL, basename(backupPath))}`)
      if (extracted > 0) notes.push(`${extracted} subtitle sidecar${extracted === 1 ? '' : 's'} written`)

      const job = this.jobs.get(id)
      if (job) {
        const seconds = job.startedAt ? ((Date.now() - job.startedAt) / 1000).toFixed(1) : '?'
        this.update({
          ...job,
          state: 'done',
          outputPath: finalPath,
          progress: { ...job.progress, fraction: 1 },
          message: notes.length > 0 ? notes.join('; ') : undefined,
          finishedAt: Date.now(),
          log: [...job.log, { at: Date.now(), level: 'info', text: `Done in ${seconds}s` }]
        })
      }
    } catch (error) {
      await discardTemporary(temporaryPath)
      const job = this.jobs.get(id)
      if (!job) return
      const cancelled = signal.aborted
      const text = cancelled ? 'Cancelled' : error instanceof Error ? error.message : String(error)

      // ffmpeg's own stderr is the part worth sharing; without it a failure
      // report says only that something went wrong.
      const detail =
        error instanceof FfmpegError
          ? `exit code ${error.exitCode ?? 'unknown'}\n\n${error.stderrTail || '(ffmpeg printed nothing to stderr)'}`
          : undefined

      this.update({
        ...job,
        state: cancelled ? 'cancelled' : 'failed',
        message: text,
        finishedAt: Date.now(),
        log: [
          ...job.log,
          { at: Date.now(), level: cancelled ? 'warn' : 'error', text, detail },
          { at: Date.now(), level: 'info', text: 'Discarded the temporary file; the original is untouched' }
        ]
      })
    }
  }

  /** Write the planned sidecar .srt files; failures are reported, not fatal. */
  private async extractSubtitles(
    result: AnalysisResult,
    finalPath: string,
    signal: AbortSignal,
    jobId: string
  ): Promise<number> {
    if (result.plan.extractSubtitles.length === 0) return 0
    const stem = join(dirname(finalPath), basename(finalPath, extname(finalPath)))
    const commands = buildSubtitleExtractCommands(result, stem)
    let written = 0
    for (const command of commands) {
      if (signal.aborted) break
      try {
        await runFfmpeg({ ffmpegPath: this.binaries.ffmpegPath, args: command.args, signal })
        written++
        this.log(jobId, 'info', `Wrote sidecar ${basename(command.outputPath)}`)
      } catch (error) {
        // A single unconvertible track should not fail the whole repair, but it
        // should not vanish either — an image-based track that slipped through
        // shows up here and nowhere else.
        this.log(
          jobId,
          'warn',
          `Could not write sidecar ${basename(command.outputPath)}`,
          error instanceof FfmpegError
            ? `exit code ${error.exitCode ?? 'unknown'}\n\n${error.stderrTail}`
            : error instanceof Error
              ? error.message
              : String(error)
        )
      }
    }
    return written
  }
}

const BACKUP_LABEL = '.plexfixer-backups'

/* ------------------------------------------------------------------ *
 * Log formatting
 * ------------------------------------------------------------------ */

function describeStrategy(strategy: AnalysisResult['plan']['strategy']): string {
  switch (strategy) {
    case 'remux':
      return 'remux (stream copy)'
    case 'transcode-audio':
      return 'remux plus an added AAC track'
    case 'transcode-video':
      return 'video re-encode'
    default:
      return 'no-op'
  }
}

/** The plan as the user would read it, so a report explains itself. */
function describePlan(result: AnalysisResult): string {
  const lines = result.plan.actions.map((action) => `• ${action.label} — ${action.detail}`)
  if (result.plan.trackChanges.length > 0) {
    lines.push('', 'Track changes:')
    for (const change of result.plan.trackChanges) {
      const bits = [
        change.drop ? 'drop' : undefined,
        change.setDefault != null ? `default=${change.setDefault}` : undefined,
        change.setForced != null ? `forced=${change.setForced}` : undefined,
        change.setLanguage ? `language=${change.setLanguage}` : undefined
      ].filter(Boolean)
      lines.push(`  stream ${change.streamIndex} (${change.kind}): ${bits.join(' ')} — ${change.reason}`)
    }
  }
  if (result.plan.unresolved.length > 0) {
    lines.push('', 'Not addressed by this plan:')
    for (const finding of result.plan.unresolved) lines.push(`  ${finding.severity}: ${finding.title}`)
  }
  return lines.join('\n')
}

/** Compact stream listing used to confirm the output after a repair. */
function describeStreams(file: AnalysisResult['file']): string {
  return file.streams
    .map((stream) => {
      const flags = [
        stream.disposition.default ? 'default' : undefined,
        stream.disposition.forced ? 'forced' : undefined
      ].filter(Boolean)
      const suffix = flags.length > 0 ? ` [${flags.join(',')}]` : ''
      return `  ${stream.index} ${stream.kind.padEnd(10)} ${stream.codec} ${stream.language}${suffix}`
    })
    .join('\n')
}

/** Render a command so it can be pasted back into a shell unchanged. */
export function quoteCommand(parts: string[]): string {
  return parts.map((part) => (/[\s"'$`\\]/.test(part) ? JSON.stringify(part) : part)).join(' ')
}
