/**
 * Executing repair plans.
 *
 * Each job writes to a temporary file beside its destination and is only
 * promoted into place after ffmpeg exits cleanly *and* the result re-probes
 * successfully. A failed or cancelled job leaves the original untouched.
 */

import { open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AnalysisResult,
  AppSettings,
  EncoderCapabilities,
  Job,
  JobLogLevel,
  JobMetrics,
  JobPhase,
  RepairMode
} from '@shared/types.js'
import { localHost, type Host } from '../host.js'
import { FfmpegError, runFfmpeg } from '../ffmpeg/run.js'
import { probeFile } from '../ffmpeg/probe.js'
import { buildRepairCommand, buildSubtitleExtractCommands } from './command.js'
import {
  discardTemporary,
  promoteOutput,
  redirectOutput,
  resolveOutputPath,
  temporaryPathFor
} from './output.js'
import { TaskQueue } from './queue.js'
import { REFUSAL_REASON, inPlaceVerdict } from '@shared/plex/inplace.js'
import { applyPatches, packLanguage, readMp4Tracks, revertPatches, type BytePatch } from './mp4-patch.js'

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
    private readonly onUpdate: JobListener,
    /** The machine the files are on; this one unless remote mode is set. */
    private host: Host = localHost()
  ) {
    this.queue = new TaskQueue(concurrency)
  }

  setBinaries(binaries: RunnerBinaries): void {
    this.binaries = binaries
  }

  setHost(host: Host): void {
    this.host = host
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
      if (isFinished(job.state)) this.jobs.delete(id)
    }
  }

  /**
   * Drop the repairs that have not started.
   *
   * Only those: a running repair is part-way through writing a file, with a
   * temporary beside it and possibly the original already moved aside, and
   * stopping that is what Cancel is for. Finished jobs are the record of what
   * happened, which "Clear finished" removes. Returns how many went.
   */
  clearQueued(): number {
    let removed = 0
    for (const [id, job] of this.jobs) {
      if (job.state !== 'queued') continue
      this.queue.cancel(id)
      this.jobs.delete(id)
      removed++
    }
    return removed
  }

  private update(job: Job): void {
    this.jobs.set(job.id, job)
    this.onUpdate(job)
  }

  /**
   * Note why this repair is copying the file rather than editing it in place.
   *
   * Without this the only visible difference is the time it takes, which is the
   * complaint rather than the explanation.
   */
  private slowPath(id: string, because: string): void {
    this.log(
      id,
      'info',
      'Rewriting the file rather than editing it in place',
      `This repair copies every byte because ${because}.\n\n` +
        'Editing in place is reserved for changes that fit in fixed-width header ' +
        'fields — language tags and default flags — on an MP4 that is being ' +
        'written back over itself.'
    )
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
   * Record how long one stage took.
   *
   * Measured rather than inferred: "the remux was slow" is only actionable
   * once it is clear whether the time went on reading the source, on the
   * second pass that moves the MP4 index, or on moving the result across
   * volumes afterwards.
   */
  private addPhase(id: string, phase: JobPhase, ms: number, extra?: { bytes?: number; note?: string }): void {
    const job = this.jobs.get(id)
    if (!job) return
    const metrics: JobMetrics = job.metrics ?? { phases: [] }
    this.update({
      ...job,
      metrics: {
        ...metrics,
        phases: [...metrics.phases.filter((entry) => entry.phase !== phase), { phase, ms: Math.round(ms), ...extra }]
      }
    })
  }

  private mergeMetrics(id: string, patch: Partial<JobMetrics>): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.update({ ...job, metrics: { ...(job.metrics ?? { phases: [] }), ...patch } })
  }

  /** Where the source and the destination live, and whether that is one volume. */
  private async recordVolumes(id: string, sourcePath: string, outputPath: string): Promise<void> {
    try {
      const [source, output] = await Promise.all([this.host.volume(sourcePath), this.host.volume(outputPath)])
      const sameVolume =
        source.device != null && output.device != null ? source.device === output.device : undefined
      this.mergeMetrics(id, { source, output, sameVolume })
    } catch {
      /* diagnostics must never fail a repair */
    }
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
    const outputPath = resolveOutputPath(result.file.path, result.plan.targetContainer, settings, scanRoot, this.host)

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

  /**
   * Write a metadata-only repair straight into the file.
   *
   * Returns false when the plan is anything more than language tags and
   * default flags, or when the file does not look exactly as expected — in
   * which case the caller falls back to the full remux, which is always safe.
   *
   * The result is re-probed afterwards, as a remux is, and the original bytes
   * go back if it does not say what it should.
   */
  private async tryInPlace(id: string, options: EnqueueOptions, outputPath: string): Promise<boolean> {
    const { result, settings } = options
    if (this.host.kind === 'remote') {
      this.slowPath(
        id,
        `the file is on ${this.host.label}, and the header edit writes bytes directly — only a full rewrite is run remotely`
      )
      return false
    }
    if (settings.outputPlacement !== 'in-place' || outputPath !== result.file.path) {
      this.slowPath(id, 'the repaired file is being written somewhere else, not over the original')
      return false
    }

    const verdict = inPlaceVerdict(result)
    if (!verdict.changes) {
      if (verdict.refusal && verdict.refusal !== 'nothing-to-do') {
        this.slowPath(id, REFUSAL_REASON[verdict.refusal])
      }
      return false
    }

    const tracks = await readMp4Tracks(result.file.path)
    if (!tracks) {
      this.slowPath(id, 'the MP4 header could not be read well enough to edit it safely')
      return false
    }

    const patches: BytePatch[] = []
    for (const change of verdict.changes) {
      const track = tracks[change.streamIndex]
      // The nth trak is ffprobe's nth stream for an MP4. If the file does not
      // line up with what was probed, do nothing clever.
      if (!track || track.index !== change.streamIndex) {
        this.slowPath(id, 'the file on disk no longer lines up with what was scanned')
        return false
      }

      if (change.setLanguage != null) {
        const packed = packLanguage(change.setLanguage)
        const currentPacked = packLanguage(track.language)
        if (packed == null || currentPacked == null) {
          this.slowPath(id, `a language tag ("${track.language}" or "${change.setLanguage}") is not three letters`)
          return false
        }
        if (packed !== currentPacked) {
          const expected = Buffer.alloc(2)
          expected.writeUInt16BE(currentPacked)
          const replacement = Buffer.alloc(2)
          replacement.writeUInt16BE(packed)
          patches.push({
            offset: track.languageOffset,
            expected,
            replacement,
            description: `stream ${change.streamIndex}: language ${track.language} -> ${change.setLanguage}`
          })
        }
      }

      if (change.setDefault != null && change.setDefault !== track.enabled) {
        const handle = await open(result.file.path, 'r')
        let currentByte: number
        try {
          const buffer = Buffer.alloc(1)
          const { bytesRead } = await handle.read(buffer, 0, 1, track.enabledFlagOffset)
          if (bytesRead !== 1) {
            this.slowPath(id, 'the track header could not be read')
            return false
          }
          currentByte = buffer.readUInt8(0)
        } finally {
          await handle.close()
        }
        const nextByte = change.setDefault ? currentByte | 0x01 : currentByte & ~0x01
        if (nextByte !== currentByte) {
          patches.push({
            offset: track.enabledFlagOffset,
            expected: Buffer.from([currentByte]),
            replacement: Buffer.from([nextByte & 0xff]),
            description: `stream ${change.streamIndex}: default ${track.enabled} -> ${change.setDefault}`
          })
        }
      }
    }

    if (patches.length === 0) return false

    const job = this.jobs.get(id)
    if (!job) return false
    this.update({ ...job, state: 'running', startedAt: Date.now(), command: [] })
    this.log(id, 'info', 'Planned actions', describePlan(result))
    this.log(
      id,
      'info',
      `Editing ${patches.length} field${patches.length === 1 ? '' : 's'} in place`,
      `${patches.map((p) => p.description).join('\n')}\n\n` +
        'These are fixed-width fields in the file header, so nothing is copied and no ' +
        'other byte is touched. No backup is kept, because the original is not being ' +
        'replaced — the before and after of every field is listed above, and the edit ' +
        'is undone automatically if the file does not read back correctly.'
    )

    try {
      await applyPatches(result.file.path, patches)
    } catch (error) {
      // Nothing was written, or it was put back. The remux still works.
      this.log(id, 'warn', 'Could not edit in place; falling back to a full remux', String(error))
      return false
    }

    try {
      const probed = await probeFile(result.file.path, {
        ffprobePath: this.binaries.ffprobePath,
        includeSidecars: false
      })
      const wrong = verdict.changes.filter((change) => {
        const stream = probed.streams.find((s) => s.index === change.streamIndex)
        if (!stream) return true
        if (change.setLanguage != null && stream.language?.toLowerCase() !== change.setLanguage.toLowerCase()) return true
        if (change.setDefault != null && stream.disposition.default !== change.setDefault) return true
        return false
      })
      if (wrong.length > 0) {
        throw new Error(`the file does not read back with the expected ${wrong.length === 1 ? 'value' : 'values'}`)
      }
      this.log(id, 'info', 'Re-probed the file', describeStreams(probed))
    } catch (error) {
      await revertPatches(result.file.path, patches).catch(() => undefined)
      this.log(id, 'warn', 'Edit did not verify; put the original bytes back', String(error))
      return false
    }

    const running = this.jobs.get(id)
    if (running) {
      const elapsed = running.startedAt ? Date.now() - running.startedAt : 0
      this.addPhase(id, 'in-place-edit', elapsed, {
        note: `${patches.length} field${patches.length === 1 ? '' : 's'} rewritten; nothing copied`
      })
      this.addPhase(id, 'total', elapsed)
      this.mergeMetrics(id, {
        sourceBytes: result.file.sizeBytes,
        durationSeconds: result.file.durationSeconds
      })
      // Re-read: the lines above are updates of their own, and spreading the
      // snapshot taken before them would throw the measurements away.
      const finished = this.jobs.get(id) ?? running
      const seconds = finished.startedAt ? ((Date.now() - finished.startedAt) / 1000).toFixed(1) : '?'
      this.update({
        ...finished,
        state: 'done',
        outputPath: result.file.path,
        progress: { ...finished.progress, fraction: 1 },
        message: 'edited in place — nothing copied',
        finishedAt: Date.now(),
        log: [...finished.log, { at: Date.now(), level: 'info', text: `Done in ${seconds}s` }]
      })
    }
    return true
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

    // Language tags and default flags are fixed-width fields in the moov
    // atom, so they can be written straight into the file. Rewriting 6 GB
    // across a network share to change four bytes is the slowest thing this
    // app does, and for most of a real library it is all a repair amounts to.
    const checkStarted = performance.now()
    if (await this.tryInPlace(id, options, outputPath)) return
    const checkMs = performance.now() - checkStarted

    const { args, encoderLabel } = buildRepairCommand({ result, settings, caps, outputPath })
    const temporaryPath = temporaryPathFor(outputPath, this.host)
    const finalArgs = redirectOutput(args, outputPath, temporaryPath)

    // Progress milestones, so a long copy leaves a trail in the log.
    let loggedMilestone = -1
    let announcedFinalise = false

    // Re-read rather than reusing the snapshot above: `tryInPlace` logs why it
    // gave up, and spreading the older copy would drop that entry.
    this.update({
      ...(this.jobs.get(id) ?? current),
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

    this.addPhase(id, 'in-place-check', checkMs, { note: 'no in-place edit was possible, so the file is rewritten' })
    this.mergeMetrics(id, { sourceBytes: result.file.sizeBytes, durationSeconds: result.file.durationSeconds })
    await this.recordVolumes(id, result.file.path, outputPath)

    // Timestamps rather than wrapped calls: each stage is one await in a
    // sequence, and bracketing them individually would bury the sequence.
    const ffmpegStarted = performance.now()
    let lastProgressAt = 0
    let finaliseFrom: number | undefined
    let lastSpeed: string | undefined

    try {
      await runFfmpeg({
        ffmpegPath: this.binaries.ffmpegPath,
        args: finalArgs,
        durationSeconds: result.file.durationSeconds,
        expectedBytes: result.file.sizeBytes,
        signal,
        spawn: (command, commandArgs) => this.host.spawn(command, commandArgs),
        // Closing the ssh connection does not reliably stop ffmpeg on the far
        // end; the temporary path is unique to this job, so the host can find
        // and stop exactly that process.
        onAbort: () => void this.host.kill(temporaryPath),
        onProgress: (progress) => {
          const job = this.jobs.get(id)
          if (!job || job.state !== 'running') return
          this.update({ ...job, progress })
          lastProgressAt = performance.now()
          if (progress.speed) lastSpeed = progress.speed
          // Everything after the last byte is reported is the finalising pass,
          // which is where an MP4 index move hides.
          if (finaliseFrom == null && progress.fraction >= 0.999) finaliseFrom = performance.now()

          // A multi-gigabyte remux over a network share runs for minutes with
          // nothing to show for it, which is indistinguishable from a hang.
          // Milestones go in the log so the report carries evidence of
          // movement rather than stopping at "writing to a temporary file".
          const milestone = Math.floor(progress.fraction * 10) * 10
          if (milestone > loggedMilestone && milestone < 100) {
            loggedMilestone = milestone
            // ffmpeg reports no position on some sources, and "0:00 of
            // 30:56" reads like a stall; bytes written are always real.
            const position =
              progress.outTimeSeconds > 0
                ? `${formatSeconds(progress.outTimeSeconds)} of ${formatSeconds(result.file.durationSeconds ?? 0)}`
                : progress.bytesWritten
                  ? `${formatBytes(progress.bytesWritten)} written`
                  : 'in progress'
            const speed = progress.speed ? `  speed ${progress.speed}` : ''
            this.log(id, 'info', `${milestone}% copied`, `${position}${speed}`)
          }

          // The index move is a second pass over the whole file, and ffmpeg
          // reports no progress during it. On a network share it can take as
          // long again as the copy, so say so rather than appearing stuck at
          // 100%.
          if (!announcedFinalise && progress.fraction >= 0.999 && result.plan.faststart) {
            announcedFinalise = true
            this.log(
              id,
              'info',
              'Moving the index to the front',
              'ffmpeg rewrites the whole file to do this and reports no progress while it runs. ' +
                'On a network share it can take about as long as the copy itself.'
            )
          }
        }
      })

      const ffmpegMs = performance.now() - ffmpegStarted
      if (signal.aborted) throw new Error('Cancelled')
      this.log(id, 'info', 'ffmpeg finished cleanly')

      const outputBytes = (await this.host.stat(temporaryPath))?.sizeBytes
      this.addPhase(id, 'ffmpeg', ffmpegMs, { bytes: outputBytes })
      this.mergeMetrics(id, {
        outputBytes,
        ffmpegSpeed: lastSpeed,
        mbPerSecond: outputBytes && ffmpegMs > 0 ? outputBytes / (1024 * 1024) / (ffmpegMs / 1000) : undefined
      })

      // The tail after the last progress report is the second pass: for an MP4
      // whose index has to move to the front, it is another run over the whole
      // file with nothing to show for it.
      const tail = finaliseFrom != null ? performance.now() - finaliseFrom : lastProgressAt ? performance.now() - lastProgressAt : 0
      if (tail > 500) {
        this.addPhase(id, 'finalise', tail, {
          note: result.plan.faststart
            ? 'second pass over the file to put the index at the front'
            : 'ffmpeg finishing after the last byte was reported'
        })
      }

      // Confirm the output is a readable media file with the streams we asked
      // for. ffmpeg can exit 0 having produced something unplayable.
      const verifyStarted = performance.now()
      const probed = await probeFile(temporaryPath, {
        ffprobePath: this.binaries.ffprobePath,
        includeSidecars: false,
        host: this.host
      })
      this.addPhase(id, 'verify', performance.now() - verifyStarted)
      const hasVideo = probed.streams.some((s) => s.kind === 'video')
      const hasAudio = probed.streams.some((s) => s.kind === 'audio')
      const sourceHadAudio = result.file.streams.some((s) => s.kind === 'audio')
      this.log(id, 'info', 'Re-probed the output', describeStreams(probed));
      if (!hasVideo || (sourceHadAudio && !hasAudio)) {
        throw new Error('The repaired file is missing streams — the original has been left untouched.')
      }

      const promoteStarted = performance.now()
      const { finalPath, backupPath } = await promoteOutput(
        temporaryPath,
        outputPath,
        result.file.path,
        settings,
        this.host
      )
      this.addPhase(id, 'promote', performance.now() - promoteStarted, {
        bytes: outputBytes,
        note: backupPath ? 'moved the original into the backup folder, then the output into place' : undefined
      })
      this.log(
        id,
        'info',
        backupPath ? 'Replaced the original (backed up first)' : 'Replaced the original',
        backupPath ? `now        ${finalPath}\noriginal   ${backupPath}` : `now        ${finalPath}`
      )

      // Sidecar subtitles are written next to the finished file, named so Plex
      // picks them up automatically.
      const subtitlesStarted = performance.now()
      const extracted = await this.extractSubtitles(result, finalPath, signal, id)
      if (result.plan.extractSubtitles.length > 0) {
        this.addPhase(id, 'subtitles', performance.now() - subtitlesStarted, {
          note: `${extracted} of ${result.plan.extractSubtitles.length} written`
        })
      }

      const notes: string[] = []
      // Writing beside the original, or into an output folder, leaves the
      // source file untouched — so the row it was started from goes on
      // reporting the same faults, correctly. Say where the fixed file went,
      // or "done" next to an unchanged status reads as a repair that failed.
      if (finalPath !== result.file.path) notes.push(`written to ${basename(finalPath)}`)
      if (backupPath) notes.push(`original kept in ${join(BACKUP_LABEL, basename(backupPath))}`)
      if (extracted > 0) notes.push(`${extracted} subtitle sidecar${extracted === 1 ? '' : 's'} written`)

      const running = this.jobs.get(id)
      if (running) {
        this.addPhase(id, 'total', running.startedAt ? Date.now() - running.startedAt : 0)
        const job = this.jobs.get(id) ?? running
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
      await discardTemporary(temporaryPath, this.host)
      const running = this.jobs.get(id)
      if (!running) return
      const cancelled = signal.aborted
      this.addPhase(id, 'total', running.startedAt ? Date.now() - running.startedAt : 0)
      const job = this.jobs.get(id) ?? running
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
    const paths = this.host.paths
    const stem = paths.join(paths.dirname(finalPath), paths.basename(finalPath, paths.extname(finalPath)))
    const commands = buildSubtitleExtractCommands(result, stem)
    let written = 0
    for (const command of commands) {
      if (signal.aborted) break
      try {
        await runFfmpeg({
          ffmpegPath: this.binaries.ffmpegPath,
          args: command.args,
          signal,
          spawn: (binary, binaryArgs) => this.host.spawn(binary, binaryArgs)
        })
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

/** Whether a job has reached a state it will not move out of. */
function isFinished(state: Job['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled' || state === 'skipped'
}

/** Bytes written so far, for progress lines when ffmpeg reports no position. */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** `1856` -> `30:56`, for progress lines in the job log. */
function formatSeconds(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0:00'
  const whole = Math.floor(total)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`
}

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
