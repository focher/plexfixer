/**
 * Executing repair plans.
 *
 * Each job writes to a temporary file beside its destination and is only
 * promoted into place after ffmpeg exits cleanly *and* the result re-probes
 * successfully. A failed or cancelled job leaves the original untouched.
 */

import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AnalysisResult, AppSettings, EncoderCapabilities, Job, RepairMode } from '@shared/types.js'
import { runFfmpeg } from '../ffmpeg/run.js'
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
      progress: { fraction: 0 }
    }

    if (mode === 'report') {
      const job: Job = { ...base, state: 'skipped', message: 'Report-only mode — nothing was written' }
      this.update(job)
      return job
    }

    if (result.plan.strategy === 'none') {
      const job: Job = { ...base, state: 'skipped', message: 'Already Plex-ready — nothing to change' }
      this.update(job)
      return job
    }

    if (result.plan.requiresTranscode && mode !== 'force-transcode') {
      const job: Job = {
        ...base,
        state: 'skipped',
        message: 'Needs a video re-encode, which safe remux will not do. Set this file or folder to Force transcode.'
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

      // Confirm the output is a readable media file with the streams we asked
      // for. ffmpeg can exit 0 having produced something unplayable.
      const probed = await probeFile(temporaryPath, { ffprobePath: this.binaries.ffprobePath, includeSidecars: false })
      const hasVideo = probed.streams.some((s) => s.kind === 'video')
      const hasAudio = probed.streams.some((s) => s.kind === 'audio')
      const sourceHadAudio = result.file.streams.some((s) => s.kind === 'audio')
      if (!hasVideo || (sourceHadAudio && !hasAudio)) {
        throw new Error('The repaired file is missing streams — the original has been left untouched.')
      }

      const { finalPath, backupPath } = await promoteOutput(
        temporaryPath,
        outputPath,
        result.file.path,
        settings
      )

      // Sidecar subtitles are written next to the finished file, named so Plex
      // picks them up automatically.
      const extracted = await this.extractSubtitles(result, finalPath, signal)

      const notes: string[] = []
      if (backupPath) notes.push(`original kept in ${join(BACKUP_LABEL, basename(backupPath))}`)
      if (extracted > 0) notes.push(`${extracted} subtitle sidecar${extracted === 1 ? '' : 's'} written`)

      const job = this.jobs.get(id)
      if (job) {
        this.update({
          ...job,
          state: 'done',
          outputPath: finalPath,
          progress: { ...job.progress, fraction: 1 },
          message: notes.length > 0 ? notes.join('; ') : undefined,
          finishedAt: Date.now()
        })
      }
    } catch (error) {
      await discardTemporary(temporaryPath)
      const job = this.jobs.get(id)
      if (!job) return
      const cancelled = signal.aborted
      this.update({
        ...job,
        state: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Cancelled' : error instanceof Error ? error.message : String(error),
        finishedAt: Date.now()
      })
    }
  }

  /** Write the planned sidecar .srt files; failures are reported, not fatal. */
  private async extractSubtitles(result: AnalysisResult, finalPath: string, signal: AbortSignal): Promise<number> {
    if (result.plan.extractSubtitles.length === 0) return 0
    const stem = join(dirname(finalPath), basename(finalPath, extname(finalPath)))
    const commands = buildSubtitleExtractCommands(result, stem)
    let written = 0
    for (const command of commands) {
      if (signal.aborted) break
      try {
        await runFfmpeg({ ffmpegPath: this.binaries.ffmpegPath, args: command.args, signal })
        written++
      } catch {
        // A single unconvertible track should not fail the whole repair.
      }
    }
    return written
  }
}

const BACKUP_LABEL = '.plexfixer-backups'
