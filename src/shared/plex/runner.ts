/**
 * Executing repair plans.
 *
 * Each job writes to a temporary file beside its destination and is only
 * promoted into place after ffmpeg exits cleanly *and* the result re-probes
 * successfully. A failed or cancelled job leaves the original untouched.
 */

import { newId } from '../ids.js'
import { begin, timed, trace } from '../trace.js'
import type {
  AnalysisResult,
  AppSettings,
  EncoderCapabilities,
  Job,
  JobOutcome,
  JobLogLevel,
  JobMetrics,
  JobPhase,
  JobStage,
  MediaFile,
  RepairMode
} from '../types.js'
import type { RepairHost } from '../host.js'
import { FfmpegError, runFfmpeg } from './ffmpeg-run.js'
import { ProbeError, probeFile } from './probe.js'
import { withQueuedOrder } from '../jobs.js'
import { QtFaststartError, runQtFaststart } from './qt-faststart.js'
import { indexMoveMismatch, isIndexMoveOnly } from './faststart.js'
import { buildMp4TagsCommand, canWriteWithMp4Tags, isMp4Container } from './mp4-tags.js'
import {
  buildRepairCommand,
  buildSubtitleReadCommand,
  buildSubtitleReadCommands
} from './command.js'
import { listenForSpeech } from '../subtitles/audio.js'
import { decodeSubtitleBytes, formatSrt, parseCues, type Cue } from '../subtitles/cues.js'
import { analyseSync, applySync } from '../subtitles/sync.js'
import {
  PromoteError,
  cloneToBackup,
  discardTemporary,
  promoteOutput,
  redirectOutput,
  resolveOutput,
  temporaryPathFor,
  uniquePath
} from './output.js'
import { outputProblem } from './verify.js'
import { TaskQueue } from './queue.js'
import { REFUSAL_REASON, inPlaceVerdict } from './inplace.js'
import { explainProblem } from './naming.js'
import { tagsOf } from './metadata.js'
import { blockingFindings } from './blocked.js'
import type { BackupRecord } from '../backups.js'
import { languageForContainer, sameLanguage } from '../languages.js'
import { applyPatches, packLanguage, readMp4Tracks, revertPatches, type BytePatch } from './mp4-patch.js'

export interface RunnerBinaries {
  ffmpegPath: string
  ffprobePath: string
  /** Moves an MP4's index in one pass, when that is the whole repair. */
  qtFaststartPath?: string
  /** Writes tags without rewriting the file; optional. */
  mp4tagsPath?: string
  /** Converts Dolby Vision profile 7 to 8.1; optional. */
  doviToolPath?: string
}

export interface EnqueueOptions {
  result: AnalysisResult
  settings: AppSettings
  mode: RepairMode
  caps?: EncoderCapabilities
  scanRoot?: string
}

export type JobListener = (job: Job) => void

/**
 * A batch of repairs on its way into the queue.
 *
 * Queueing is not instant. Every file is re-probed first so its plan reflects
 * today's settings rather than whatever was true when it was scanned, and on a
 * remote host that is a round trip each — a few hundred files take a while to
 * all arrive. Cancelling during that stretch has to stop the arrivals too, or
 * the queue fills back up behind the click.
 */
export interface QueueBatch {
  /** Checked between files; once true, the caller stops adding. */
  readonly cancelled: boolean
  /** Done adding, whether it finished or was stopped. */
  finish(): void
}

export class RepairRunner {
  private readonly queue: TaskQueue
  private readonly jobs = new Map<string, Job>()
  private readonly batches = new Set<{ cancelled: boolean }>()

  constructor(
    private binaries: RunnerBinaries,
    concurrency: number,
    private readonly onUpdate: JobListener,
    /** The machine the files are on; this one unless remote mode is set. */
    private host: RepairHost
  ) {
    this.queue = new TaskQueue(concurrency)
  }

  /**
   * The temporary files of repairs that are queued or running, which a scan
   * must not mistake for leftovers.
   */
  activeTemporaryPaths(): Set<string> {
    const paths = new Set<string>()
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') paths.add(temporaryPathFor(job.outputPath, this.host))
    }
    return paths
  }

  /** Told about every backup a repair makes, so it can be expired later. */
  onBackup?: (record: BackupRecord) => void

  private noteBackup(path: string, original: string, clone = false): void {
    try {
      this.onBackup?.({ path, original, createdAt: Date.now(), host: this.host.label, ...(clone ? { clone } : {}) })
    } catch {
      /* the record is housekeeping; it never fails a repair */
    }
  }

  setBinaries(binaries: RunnerBinaries): void {
    this.binaries = binaries
  }

  setHost(host: RepairHost): void {
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

  /**
   * Say that a batch is being added, so that cancelling can stop it.
   *
   * The caller checks `cancelled` between files and calls `finish()` when it
   * is done either way.
   *
   * A batch that arrives into an idle queue holds it until the whole batch is
   * in. Adding is slow — every file is probed on the way — so without this the
   * first file would start repairing while the rest were still being looked
   * at, which puts a repair and a run of probes on the same disk at once and
   * leaves the queue looking half-built. Nothing is lost by waiting: the files
   * are going to be repaired either way, and now they all arrive before any of
   * them competes for the disk.
   *
   * A batch added to a queue that is *already* working does not hold it. That
   * queue has made its start, the running repairs would carry on regardless,
   * and holding would only idle the slots they leave behind.
   */
  beginBatch(): QueueBatch {
    const batch = { cancelled: false }
    this.batches.add(batch)
    const release = this.queue.activeCount === 0 ? this.queue.hold() : undefined
    return {
      get cancelled(): boolean {
        return batch.cancelled
      },
      finish: () => {
        this.batches.delete(batch)
        release?.()
      }
    }
  }

  /** Stop every batch still being added. */
  private stopBatches(): void {
    for (const batch of this.batches) batch.cancelled = true
    this.batches.clear()
  }

  /**
   * Stop everything: what is running, what is waiting, and what is still
   * arriving.
   *
   * A running repair is aborted and keeps its row, because it got part-way and
   * what it did is worth seeing. The ones that never started are removed
   * outright rather than left as a wall of cancelled rows — "Cancel all" is
   * reached for when a batch was a mistake, and a hundred rows saying so is
   * not a record of anything. Returns the ids that went, so the window can
   * drop exactly those and not a job that began in the meantime.
   */
  cancelAll(): string[] {
    this.stopBatches()
    this.queue.cancelAll()
    const removed: string[] = []
    for (const [id, job] of this.jobs) {
      if (job.state !== 'queued') continue
      this.jobs.delete(id)
      removed.push(id)
    }
    return removed
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
   *
   * A batch still being added is stopped as well. Without that, clearing a
   * queue that is still filling just makes room for the rest of it.
   */
  clearQueued(): number {
    this.stopBatches()
    let removed = 0
    for (const [id, job] of this.jobs) {
      if (job.state !== 'queued') continue
      this.queue.cancel(id)
      this.jobs.delete(id)
      removed++
    }
    return removed
  }

  /**
   * Move a waiting repair to a given place in the queue.
   *
   * `index` counts from the front of what is waiting, so 0 is next out, and it
   * is clamped — dropping something past the bottom of the list means the
   * bottom. Returns the new order of the waiting repairs, which the window
   * applies to the list it is drawing, or `undefined` when nothing moved.
   *
   * Only a queued repair can be moved. What is running is already writing a
   * file, and what has finished is a record of something that happened;
   * neither has a place in an order that is about what happens next.
   */
  moveQueuedTo(id: string, index: number): string[] | undefined {
    const job = this.jobs.get(id)
    if (!job || job.state !== 'queued') return undefined

    const order = this.queue.moveTo(id, index)
    if (!order) return undefined

    // The list the window draws is this map's order, so the two have to move
    // together: a repair that changed places in the queue and stayed put on
    // screen would look like a button that does nothing.
    this.applyQueuedOrder(order)
    return order
  }

  /** The queued repairs, in the order they will be started. */
  queuedOrder(): string[] {
    return this.queue.pendingIds()
  }

  /**
   * Deal the waiting repairs back into the places they hold in the list.
   *
   * A `Map` keeps what is put into it in order and offers no way to reorder
   * it, so it is rebuilt. The queue is tens of rows, not thousands. The rule
   * for which row goes where is the window's rule too, and lives beside it.
   */
  private applyQueuedOrder(order: string[]): void {
    const rows = [...this.jobs.values()]
    const next = withQueuedOrder(rows, (job) => job.state === 'queued', order)

    this.jobs.clear()
    for (const job of next) this.jobs.set(job.id, job)
  }

  private update(job: Job): void {
    // A job removed from the list stays removed. A task that was already
    // off the queue when it was dropped still reports its abort, and this
    // used to put the row back — the one thing "Clear queue" and "Cancel all"
    // must not do. `enqueue` puts the job in the list before its first update.
    if (!this.jobs.has(job.id)) return
    // Every update is also a sign of life: the queue uses this to tell a job
    // that is working from one whose link has gone quiet.
    const stamped = { ...job, updatedAt: Date.now() }
    this.jobs.set(stamped.id, stamped)
    this.onUpdate(stamped)
  }

  /** Move a job to its next step, for the indicator in the queue. */
  private setStage(id: string, stage: JobStage): void {
    const job = this.jobs.get(id)
    if (!job || job.stage === stage) return
    trace('job', `stage ${job.stage ?? 'none'} -> ${stage}`, { ref: id })
    this.update({ ...job, stage })
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
    const id = newId()
    // What the file will say about itself once this job is done: its own tags
    // with whatever the plan is about to write over the top. A naming pattern
    // then sees the title a lookup set in this very job, not the one it is
    // replacing.
    const tags = { ...tagsOf(result.file), ...(result.plan.metadataTags ?? {}) }
    const { path: outputPath, problem: namingProblem } = resolveOutput(
      result.file.path,
      result.plan.targetContainer,
      settings,
      this.host,
      scanRoot,
      tags
    )

    const base: Job = {
      id,
      sourcePath: result.file.path,
      outputPath,
      strategy: result.plan.strategy,
      mode,
      state: 'queued',
      stage: 'waiting',
      // Recorded now rather than read from the settings later: remote mode is
      // a setting, and the queue outlives a change to it.
      host: { kind: this.host.kind, label: this.host.label },
      progress: { fraction: 0 },
      log: [
        {
          at: Date.now(),
          level: 'info',
          text:
            result.plan.strategy === 'none' && onlyTheName(settings, result.file.path, outputPath)
              ? 'Queued a rename'
              : `Queued ${describeStrategy(result.plan.strategy)}`,
          detail:
            `source     ${result.file.path}\n` +
            `target     ${outputPath}\n` +
            `container  ${result.file.container} -> ${result.plan.targetContainer}\n` +
            `mode       ${mode}\n` +
            `plan       ${result.plan.costNote}` +
            // Silence here would read as "the pattern did nothing", which is
            // the one thing it never does: it either renamed or it said why.
            (namingProblem && namingProblem.kind !== 'no-template'
              ? `\nnaming     ${explainProblem(namingProblem)}`
              : '')
        }
      ]
    }

    // In the list before anything reports on it, because `update` will not
    // add a job it has not seen.
    this.jobs.set(id, base)
    // The one line that ties a job id in the rest of the log to a file.
    trace('job', `queued ${result.file.path} (${result.plan.strategy}, mode ${mode})`, { ref: id })

    if (mode === 'report') {
      const job: Job = {
        ...base,
        stage: 'finished',
        state: 'skipped',
        outcome: 'report-only',
        message: 'Report-only mode — nothing was written',
        log: [...base.log, { at: Date.now(), level: 'info', text: 'Skipped: report-only mode' }]
      }
      this.update(job)
      return job
    }

    if (result.plan.strategy === 'none') {
      // A file with nothing wrong with it can still have the wrong *name*,
      // once a naming pattern is set. That is a rename and nothing else — no
      // byte of it changes — so it is worth doing and must not cost what a
      // repair costs.
      if (!onlyTheName(settings, result.file.path, outputPath)) {
        const nothing = nothingToDo(result)
        const job: Job = {
          ...base,
          stage: 'finished',
          state: 'skipped',
          outcome: nothing.outcome,
          message: nothing.message,
          log: [
            ...base.log,
            { at: Date.now(), level: 'info', text: `Skipped: ${nothing.text}`, detail: nothing.detail }
          ]
        }
        this.update(job)
        return job
      }

      this.update(base)
      void this.queue.add({
        id,
        run: async () => {
          await this.justRename(id, result.file.path, outputPath)
        }
      })
      return base
    }

    if (result.plan.requiresTranscode && mode !== 'force-transcode') {
      const job: Job = {
        ...base,
        stage: 'finished',
        state: 'skipped',
        outcome: 'needs-transcode',
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
   * Give the file its new name, moving it rather than copying it.
   *
   * A rename within a folder costs nothing and reads nothing: the file keeps
   * its place on disk and only the directory entry changes. Writing the file
   * out under the new name and deleting the old one would read and write every
   * byte to reach the same end, and across a network share that is the entire
   * cost of the job.
   *
   * A different file already sitting at the new name is left exactly where it
   * is, as everywhere else here, and the next free name is taken instead.
   * Returns where the file ended up.
   */
  private async renameTo(id: string, sourcePath: string, outputPath: string): Promise<string> {
    await this.host.mkdirp(this.host.paths.dirname(outputPath))
    const finalPath = await uniquePath(outputPath, this.host)
    await this.host.rename(sourcePath, finalPath)
    if (finalPath !== outputPath) {
      this.log(
        id,
        'warn',
        `A different file was already at ${this.host.paths.basename(outputPath)}, so it was left alone`,
        `kept       ${outputPath}\nrenamed    ${finalPath}\n\n` +
          'Renaming this file was asked for; replacing that one was not, so the next free name was taken.'
      )
    }
    this.log(
      id,
      'info',
      'Renamed the file',
      `from       ${sourcePath}\nto         ${finalPath}\n\n` +
        'Nothing was copied: the file stays exactly where it is on disk and only its name changed.'
    )
    return finalPath
  }

  /**
   * A job whose whole content is a new name.
   *
   * The file is already everything Plex wants it to be; the naming pattern
   * says it should be called something else. There is nothing to back up,
   * because nothing is being changed — the same bytes answer to a new name.
   */
  private async justRename(id: string, sourcePath: string, outputPath: string): Promise<void> {
    const queued = this.jobs.get(id)
    if (!queued) return
    this.update({ ...queued, state: 'running', stage: 'promoting', startedAt: Date.now(), command: [] })

    try {
      const finalPath = await this.renameTo(id, sourcePath, outputPath)
      const running = this.jobs.get(id)
      if (!running) return
      const elapsed = running.startedAt ? Date.now() - running.startedAt : 0
      this.addPhase(id, 'promote', elapsed, { note: 'renamed; nothing copied' })
      this.addPhase(id, 'total', elapsed)
      // Re-read: the two lines above are updates of their own, and spreading
      // the snapshot taken before them would throw the measurements away.
      const finished = this.jobs.get(id) ?? running
      this.update({
        ...finished,
        state: 'done',
        outcome: 'renamed',
        stage: 'finished',
        outputPath: finalPath,
        progress: { ...finished.progress, fraction: 1 },
        message: `renamed to ${this.host.paths.basename(finalPath)} — nothing copied`,
        finishedAt: Date.now(),
        log: [...finished.log, { at: Date.now(), level: 'info', text: 'Done' }]
      })
    } catch (error) {
      const running = this.jobs.get(id)
      if (!running) return
      const text = error instanceof Error ? error.message : String(error)
      this.update({
        ...running,
        state: 'failed',
        stage: 'finished',
        message: text,
        finishedAt: Date.now(),
        log: [
          ...running.log,
          { at: Date.now(), level: 'error', text: `Could not rename the file: ${text}` },
          { at: Date.now(), level: 'info', text: 'The file is untouched, under the name it had' }
        ]
      })
    }
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
    // A different *name* in the same folder is no reason to rewrite the file:
    // the header edit happens where the file lies and the rename follows it.
    // A different *place* is, because that is a second file, not a move.
    if (settings.outputPlacement !== 'in-place') {
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

    const tracks = await readMp4Tracks(result.file.path, this.host)
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
        // The plan holds the canonical ISO 639-2/B code; `mdhd` wants /T
        // ("fra", not "fre"), which is what MP4 players read.
        const written = languageForContainer(change.setLanguage, 'mp4')
        const packed = packLanguage(written)
        const currentPacked = packLanguage(track.language)
        if (packed == null || currentPacked == null) {
          this.slowPath(id, `a language tag ("${track.language}" or "${change.setLanguage}") is not three letters`)
          return false
        }
        if (packed !== currentPacked) {
          // Two bytes, big-endian, without Node's Buffer: this runs in a
          // webview as well.
          const expected = Uint8Array.from([currentPacked >> 8, currentPacked & 0xff])
          const replacement = Uint8Array.from([packed >> 8, packed & 0xff])
          patches.push({
            offset: track.languageOffset,
            expected,
            replacement,
            description: `stream ${change.streamIndex}: language ${track.language} -> ${written}`
          })
        }
      }

      if (change.setDefault != null && change.setDefault !== track.enabled) {
        const header = await this.host.readRange(result.file.path, track.enabledFlagOffset, 1)
        if (header.length !== 1) {
          this.slowPath(id, 'the track header could not be read')
          return false
        }
        const currentByte = header[0]
        const nextByte = change.setDefault ? currentByte | 0x01 : currentByte & ~0x01
        if (nextByte !== currentByte) {
          patches.push({
            offset: track.enabledFlagOffset,
            expected: Uint8Array.from([currentByte]),
            replacement: Uint8Array.from([nextByte & 0xff]),
            description: `stream ${change.streamIndex}: default ${track.enabled} -> ${change.setDefault}`
          })
        }
      }
    }

    if (patches.length === 0) return false

    const job = this.jobs.get(id)
    if (!job) return false
    this.update({ ...job, state: 'running', stage: 'planning', startedAt: Date.now(), command: [] })
    this.log(id, 'info', 'Planned actions', describePlan(result))
    // An instant clone before the edit, where the volume can make one: it
    // shares the file's data, so it costs no time and almost no space.
    let backupPath: string | undefined
    try {
      backupPath = await cloneToBackup(result.file.path, settings, this.host)
    } catch (error) {
      this.log(id, 'warn', 'Could not make an instant backup; editing without one', String(error))
    }
    if (backupPath) {
      this.noteBackup(backupPath, result.file.path, true)
      this.log(
        id,
        'info',
        'Instant backup (APFS clone)',
        `${backupPath}\n\nThe clone shares the original's data on disk, so it was made instantly and uses ` +
          'almost no space until the file changes.'
      )
    }

    this.log(
      id,
      'info',
      `Editing ${patches.length} field${patches.length === 1 ? '' : 's'} in place`,
      `${patches.map((p) => p.description).join('\n')}\n\n` +
        'These are fixed-width fields in the file header, so nothing is copied and no ' +
        'other byte is touched. ' +
        (backupPath
          ? 'The original is kept as an instant clone (above). '
          : settings.keepBackups
            ? 'No backup is kept: this volume cannot make an instant copy, and a full copy would ' +
              'cost far more than the edit. '
            : 'Backups are turned off. ') +
        'The before and after of every field is listed above, and the edit is undone ' +
        'automatically if the file does not read back correctly.'
    )

    try {
      await applyPatches(result.file.path, patches, this.host)
    } catch (error) {
      // Nothing was written, or it was put back. The remux still works.
      this.log(id, 'warn', 'Could not edit in place; falling back to a full remux', String(error))
      return false
    }

    try {
      const probed = await probeFile(result.file.path, {
        ffprobePath: this.binaries.ffprobePath,
        host: this.host
      })
      const wrong = verdict.changes.filter((change) => {
        const stream = probed.streams.find((s) => s.index === change.streamIndex)
        if (!stream) return true
        // ffprobe reports the stored /T code; the plan holds /B. Same language.
        if (change.setLanguage != null && !sameLanguage(stream.language, change.setLanguage)) return true
        if (change.setDefault != null && stream.disposition.default !== change.setDefault) return true
        return false
      })
      if (wrong.length > 0) {
        throw new Error(`the file does not read back with the expected ${wrong.length === 1 ? 'value' : 'values'}`)
      }
      this.log(id, 'info', 'Re-probed the file', describeStreams(probed))
    } catch (error) {
      await revertPatches(result.file.path, patches, this.host).catch(() => undefined)
      this.log(id, 'warn', 'Edit did not verify; put the original bytes back', String(error))
      return false
    }

    // The edit is done and verified; the name is the last thing left. A
    // failure here leaves a correctly repaired file under its old name, which
    // is worth saying but is not a failed repair.
    let finalPath = result.file.path
    let renameFailed: string | undefined
    if (outputPath !== finalPath) {
      this.setStage(id, 'promoting')
      try {
        finalPath = await this.renameTo(id, finalPath, outputPath)
      } catch (error) {
        renameFailed = error instanceof Error ? error.message : String(error)
        this.log(
          id,
          'warn',
          'The file was repaired, but could not be renamed',
          `${renameFailed}\n\nThe repair itself is done; the file is still called ` +
            `${this.host.paths.basename(finalPath)}.`
        )
      }
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
      const notes = [
        'edited in place — nothing copied',
        finalPath !== result.file.path ? `renamed to ${this.host.paths.basename(finalPath)}` : undefined,
        renameFailed ? 'could not be renamed' : undefined,
        backupPath
          ? `original kept in ${this.host.paths.join(BACKUP_LABEL, this.host.paths.basename(backupPath))}`
          : undefined
      ].filter(Boolean)
      this.update({
        ...finished,
        state: 'done',
        outcome: 'repaired',
        stage: 'finished',
        outputPath: finalPath,
        progress: { ...finished.progress, fraction: 1 },
        message: notes.join('; '),
        finishedAt: Date.now(),
        log: [...finished.log, { at: Date.now(), level: 'info', text: `Done in ${seconds}s` }]
      })
    }
    return true
  }

  /**
   * Write the file's own tags without rewriting the file.
   *
   * A title or an episode number is text of any length, so it cannot be slotted
   * into the header the way a language tag can — which is why this used to mean
   * a full remux, reading and writing every byte of a film to change two words.
   * `mp4tags` does it properly: it keeps `free` padding beside the header and
   * rewrites the chunk-offset tables when the header grows, so `mdat` never
   * moves. The same library Subler uses, which is why that app is instant.
   *
   * Narrow on purpose. It runs only when writing tags is the *whole* repair: a
   * plan that also drops a track or re-encodes has to copy the file anyway, and
   * doing both would write the file twice.
   *
   * Returns false for anything it will not do, and the ordinary remux follows.
   */
  private async tryTagsOnly(id: string, options: EnqueueOptions, outputPath: string): Promise<boolean> {
    const { result, settings } = options
    const tags = result.plan.metadataTags
    if (!tags || Object.keys(tags).length === 0) return false

    const mp4tags = this.binaries.mp4tagsPath
    if (!mp4tags) return false
    if (this.host.kind === 'remote') return false
    // Writing where the file lies is the whole point; somewhere else is a copy.
    if (settings.outputPlacement !== 'in-place' || outputPath !== result.file.path) return false
    if (!isMp4Container(result.file.extension)) return false
    if (!canWriteWithMp4Tags(tags)) return false

    // Everything else the plan might do needs the file rewritten. Tags have to
    // be all of it.
    const plan = result.plan
    if (plan.strategy === 'transcode-video' || plan.requiresTranscode) return false
    if (plan.videoTranscode || plan.addCompatibilityAudio) return false
    if (plan.trackChanges.length > 0 || plan.resyncSubtitles.length > 0) return false
    if (plan.targetContainer !== 'mp4' || plan.videoCodecTag || plan.videoLevel != null) return false
    // Moving the index is a rewrite of the file by definition.
    if (plan.faststart && result.file.faststart !== true) return false

    const job = this.jobs.get(id)
    if (!job) return false

    const args = buildMp4TagsCommand(result.file.path, tags)
    if (args.length === 0) return false

    this.update({ ...job, state: 'running', stage: 'planning', startedAt: Date.now(), command: [mp4tags, ...args] })
    this.log(id, 'info', 'Planned actions', describePlan(result))

    // The same instant clone the header editor takes: it shares the file's
    // data, so it costs no time and almost no space.
    let backupPath: string | undefined
    try {
      backupPath = await cloneToBackup(result.file.path, settings, this.host)
    } catch (error) {
      this.log(id, 'warn', 'Could not make an instant backup; writing the tags without one', String(error))
    }
    if (backupPath) this.noteBackup(backupPath, result.file.path, true)

    this.log(
      id,
      'info',
      `Writing ${Object.keys(tags).length} tag${Object.keys(tags).length === 1 ? '' : 's'} into the file`,
      `${Object.entries(tags)
        .map(([key, value]) => `${key} = ${value || '(cleared)'}`)
        .join('\n')}\n\n` +
        'Written into the header where the file lies. The film itself is not copied, ' +
        'so this takes about as long on a 40 GB file as on a 40 MB one.'
    )

    try {
      await this.host.exec(mp4tags, args, { timeoutMs: 120_000 })
    } catch (error) {
      // Nothing is half-written: mp4tags either rewrites the header or leaves
      // it. The remux still works, so this is a fallback and not a failure.
      this.log(id, 'warn', 'Could not write the tags in place; falling back to a full rewrite', String(error))
      return false
    }

    // The same gate the header editor uses: what does the file say now?
    try {
      const probed = await probeFile(result.file.path, {
        ffprobePath: this.binaries.ffprobePath,
        host: this.host
      })
      const missing = Object.entries(tags).filter(([key, value]) => {
        const written = Object.entries(probed.tags).find(([name]) => name.toLowerCase() === key)?.[1]
        return value.trim() === '' ? written != null && written.trim() !== '' : (written ?? '') !== value
      })
      if (missing.length > 0) {
        throw new Error(`the file does not read back with ${missing.map(([key]) => key).join(', ')}`)
      }
    } catch (error) {
      this.log(id, 'warn', 'The tags did not verify; falling back to a full rewrite', String(error))
      return false
    }

    const running = this.jobs.get(id)
    if (running) {
      const elapsed = running.startedAt ? Date.now() - running.startedAt : 0
      this.addPhase(id, 'in-place-edit', elapsed, { note: 'tags written into the header; nothing copied' })
      this.addPhase(id, 'total', elapsed)
      const finished = this.jobs.get(id) ?? running
      const seconds = finished.startedAt ? ((Date.now() - finished.startedAt) / 1000).toFixed(1) : '?'
      this.update({
        ...finished,
        state: 'done',
        outcome: 'repaired',
        stage: 'finished',
        outputPath: result.file.path,
        progress: { ...finished.progress, fraction: 1 },
        message: [
          'tags written in place — nothing copied',
          backupPath
            ? `original kept in ${this.host.paths.join(BACKUP_LABEL, this.host.paths.basename(backupPath))}`
            : undefined
        ]
          .filter(Boolean)
          .join('; '),
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
    const { result } = options
    const current = this.jobs.get(id)
    if (!current) return
    const finishedExecuting = begin('job', `repairing ${this.host.paths.basename(result.file.path)}`, { ref: id })
    try {
      await this.repair(id, options, outputPath, signal, current)
      finishedExecuting()
    } catch (error) {
      finishedExecuting({ failed: error })
      throw error
    }
  }

  /** The repair itself; `execute` wraps this so the report can time it. */
  private async repair(
    id: string,
    options: EnqueueOptions,
    outputPath: string,
    signal: AbortSignal,
    current: Job
  ): Promise<void> {
    const { result, settings, caps } = options

    // Language tags and default flags are fixed-width fields in the moov
    // atom, so they can be written straight into the file. Rewriting 6 GB
    // across a network share to change four bytes is the slowest thing this
    // app does, and for most of a real library it is all a repair amounts to.
    // Reaching the file at all is a step of its own when it is on another
    // machine: an unreachable host hangs here, not in ffmpeg.
    this.setStage(id, 'connecting')
    const checkStarted = performance.now()
    // Tags first: a tag edit is the one repair that needs neither a copy nor a
    // header patch, and asking about it before the patcher keeps the patcher's
    // refusal reasons about the things it actually refuses.
    //
    // Both of these run while the row still reads "Queued", because neither
    // has committed to anything yet — which is why they are traced by name. A
    // repair that appears not to have started is usually one of these waiting
    // on a file server, and without this the log shows nothing at all.
    if (await timed('job', 'checking whether tags alone would do', () => this.tryTagsOnly(id, options, outputPath), id)) {
      return
    }
    if (await timed('job', 'checking whether the header can be edited in place', () => this.tryInPlace(id, options, outputPath), id)) {
      return
    }
    const checkMs = performance.now() - checkStarted

    // Before the repair, not after: the retimed tracks are inputs to it. The
    // measurement reads the audio from end to end, which is why it is only
    // done when the plan actually asked for it.
    const retimedSubtitles = await timed(
      'job',
      'checking subtitle timing',
      () => this.retimeSubtitles(id, result, settings, signal),
      id
    )
    if (signal.aborted) return

    // Likewise an input: the converted Dolby Vision stream is a file on disk
    // by the time ffmpeg is asked to mux anything.
    const convertedVideo = await timed(
      'job',
      'converting Dolby Vision if needed',
      () => this.convertDolbyVision7(id, result, signal),
      id
    )
    if (signal.aborted) {
      if (convertedVideo) await this.host.remove(convertedVideo.path).catch(() => {})
      return
    }

    const { args, encoderLabel } = buildRepairCommand({
      result,
      settings,
      caps,
      outputPath,
      retimedSubtitles,
      convertedVideo
    })
    const temporaryPath = temporaryPathFor(outputPath, this.host)
    const finalArgs = redirectOutput(args, outputPath, temporaryPath)

    const ffmpegCommand = [this.binaries.ffmpegPath, ...finalArgs]
    // When moving the index is the whole repair, qt-faststart does it in one
    // read and one write; ffmpeg would remux and then rewrite the file again.
    const qtFaststartPath = this.binaries.qtFaststartPath
    const qtCommand =
      qtFaststartPath && isIndexMoveOnly(result) ? [qtFaststartPath, result.file.path, temporaryPath] : undefined

    // Re-read rather than reusing the snapshot above: `tryInPlace` logs why it
    // gave up, and spreading the older copy would drop that entry.
    this.update({
      ...(this.jobs.get(id) ?? current),
      state: 'running',
      stage: 'planning',
      startedAt: Date.now(),
      command: qtCommand ?? ffmpegCommand,
      message: encoderLabel ? `Encoding with ${encoderLabel}` : undefined
    })

    this.log(id, 'info', 'Planned actions', describePlan(result))
    const announceFfmpeg = (): void => {
      this.log(
        id,
        'info',
        encoderLabel ? `Running ffmpeg (${encoderLabel})` : 'Running ffmpeg (stream copy)',
        quoteCommand(ffmpegCommand)
      )
      this.log(id, 'info', 'Writing to a temporary file first', temporaryPath)
    }
    if (!qtCommand) announceFfmpeg()

    this.addPhase(id, 'in-place-check', checkMs, { note: 'no in-place edit was possible, so the file is rewritten' })
    this.mergeMetrics(id, { sourceBytes: result.file.sizeBytes, durationSeconds: result.file.durationSeconds })

    // Timestamps rather than wrapped calls: each stage is one await in a
    // sequence, and bracketing them individually would bury the sequence.
    this.setStage(id, 'copying')
    // Set once the repaired file is in place. A failure after that is a
    // failure with the repair already done, and must not be reported — or
    // cleaned up after — as though nothing had been touched.
    let promotedTo: string | undefined

    try {
      // ffmpeg writes the temporary file beside the destination, and it will
      // not create the folder to put it in. An output directory that mirrors
      // the library has a folder per film, so the first repair into a new one
      // asked ffmpeg to open a file in a directory that did not exist yet and
      // it stopped with "No such file or directory" before reading a frame.
      // `promoteOutput` makes the folder too, but that is long after this.
      await this.host.mkdirp(this.host.paths.dirname(temporaryPath))
      // After the folder exists, so the output volume is a real answer rather
      // than "unknown" on the very repair that creates it.
      await this.recordVolumes(id, result.file.path, outputPath)

      let probed: MediaFile | undefined
      let outputBytes: number | undefined
      if (qtCommand) {
        probed = await this.moveIndexWithQtFaststart(id, result, qtCommand, temporaryPath, signal)
        if (probed) {
          outputBytes = probed.sizeBytes
        } else {
          const job = this.jobs.get(id)
          if (job) this.update({ ...job, command: ffmpegCommand, progress: { fraction: 0 } })
          announceFfmpeg()
        }
      }

      if (!probed) {
        outputBytes = await this.remux(id, result, finalArgs, temporaryPath, signal)

        // Confirm the output is a readable media file with the streams we asked
        // for. ffmpeg can exit 0 having produced something unplayable.
        this.setStage(id, 'verifying')
        const verifyStarted = performance.now()
        probed = await this.verifyOutput(id, temporaryPath, signal)
        this.addPhase(id, 'verify', performance.now() - verifyStarted)
      }
      this.log(id, 'info', 'Re-probed the output', describeStreams(probed))
      const problem = outputProblem(result.file, probed)
      if (problem) throw new Error(problem)

      this.setStage(id, 'promoting')
      const promoteStarted = performance.now()
      const { finalPath, backupPath, originalLeft } = await promoteOutput(
        temporaryPath,
        outputPath,
        result.file.path,
        settings,
        this.host
      )
      promotedTo = finalPath
      if (backupPath) this.noteBackup(backupPath, result.file.path)
      if (settings.outputPlacement === 'in-place' && finalPath !== outputPath) {
        this.log(
          id,
          'warn',
          `A different file was already at ${this.host.paths.basename(outputPath)}, so it was left alone`,
          `kept       ${outputPath}\nrepaired   ${finalPath}\n\n` +
            'Replacing the original was asked for; that file was not. The repaired file took the next free name.'
        )
      }
      if (originalLeft) {
        this.log(
          id,
          'warn',
          'The repaired file is in place, but the original could not be cleared away',
          `${result.file.path}\n\n${originalLeft}\n\nBoth files are there. Nothing was lost.`
        )
      }
      this.addPhase(id, 'promote', performance.now() - promoteStarted, {
        bytes: outputBytes,
        note: backupPath ? 'moved the original into the backup folder, then the output into place' : undefined
      })
      this.log(
        id,
        'info',
        originalLeft
          ? 'Wrote the repaired file beside the original'
          : backupPath
            ? 'Replaced the original (backed up first)'
            : 'Replaced the original',
        backupPath ? `now        ${finalPath}\noriginal   ${backupPath}` : `now        ${finalPath}`
      )

      const notes: string[] = []
      // Writing beside the original, or into an output folder, leaves the
      // source file untouched — so the row it was started from goes on
      // reporting the same faults, correctly. Say where the fixed file went,
      // or "done" next to an unchanged status reads as a repair that failed.
      if (finalPath !== result.file.path) notes.push(`written to ${this.host.paths.basename(finalPath)}`)
      if (backupPath) notes.push(`original kept in ${this.host.paths.join(BACKUP_LABEL, this.host.paths.basename(backupPath))}`)
      if (retimedSubtitles.length > 0) {
        notes.push(`${retimedSubtitles.length} subtitle track${retimedSubtitles.length === 1 ? '' : 's'} retimed`)
      }

      const running = this.jobs.get(id)
      if (running) {
        this.addPhase(id, 'total', running.startedAt ? Date.now() - running.startedAt : 0)
        const job = this.jobs.get(id) ?? running
        const seconds = job.startedAt ? ((Date.now() - job.startedAt) / 1000).toFixed(1) : '?'
        this.update({
          ...job,
          state: 'done',
          outcome: 'repaired',
          stage: 'finished',
          outputPath: finalPath,
          progress: { ...job.progress, fraction: 1 },
          message: notes.length > 0 ? notes.join('; ') : undefined,
          finishedAt: Date.now(),
          log: [...job.log, { at: Date.now(), level: 'info', text: `Done in ${seconds}s` }]
        })
      }
    } catch (error) {
      // A promotion that stopped half way and could not be undone has left the
      // repaired file in its temporary as the only copy beside the library —
      // tidying that away is how a failed move used to become a lost file.
      const stranded = error instanceof PromoteError
      if (!stranded && !promotedTo) await discardTemporary(temporaryPath, this.host)
      const running = this.jobs.get(id)
      if (!running) return
      const cancelled = signal.aborted
      this.addPhase(id, 'total', running.startedAt ? Date.now() - running.startedAt : 0)
      const job = this.jobs.get(id) ?? running
      const text = cancelled
        ? 'Cancelled'
        : (this.connectionLost(error) ?? (error instanceof Error ? error.message : String(error)))

      // ffmpeg's own stderr is the part worth sharing; without it a failure
      // report says only that something went wrong.
      const detail =
        error instanceof FfmpegError
          ? `exit code ${error.exitCode ?? 'unknown'}\n\n${error.stderrTail || '(ffmpeg printed nothing to stderr)'}`
          : // A refused output is reported in one line, and the line ffprobe
            // leads with is seldom the reason. The whole of what it printed
            // goes here, where there is room for it.
            error instanceof ProbeError
            ? error.detail
            : undefined

      this.update({
        ...job,
        state: cancelled ? 'cancelled' : 'failed',
        message: text,
        finishedAt: Date.now(),
        log: [
          ...job.log,
          { at: Date.now(), level: cancelled ? 'warn' : 'error', text, detail },
          // Only what is true is said here. This line used to be fixed, and
          // claimed the original was untouched after it had been moved.
          stranded
            ? {
                at: Date.now(),
                level: 'error',
                text: 'Kept both files where they are; nothing was deleted',
                detail: `original   ${error.backupPath}\nrepaired   ${error.temporaryPath}`
              }
            : promotedTo
              ? { at: Date.now(), level: 'info', text: 'The repaired file is already in place', detail: promotedTo }
              : { at: Date.now(), level: 'info', text: 'Discarded the temporary file; the original is untouched' }
        ]
      })
    } finally {
      // The converted Dolby Vision stream is the size of the film's video and
      // is of no use once the mux has read it. It goes whether the repair
      // worked, failed or was cancelled — a scratch file this large left
      // behind after a cancel is its own kind of bug.
      if (convertedVideo) {
        await this.host.remove(convertedVideo.path).catch(() => {})
      }
    }
  }

  /**
   * ssh's own failure, told apart from ffmpeg's.
   *
   * 255 is the exit code ssh reserves for its own errors, and ffmpeg does not
   * use it — so a repair that comes back with 255 and nothing on stderr is the
   * link going down, not the encode failing. Saying so is the difference
   * between "try again" and "go and look at the file".
   */
  private connectionLost(error: unknown): string | undefined {
    if (this.host.kind !== 'remote') return undefined
    if (!(error instanceof FfmpegError) || error.exitCode !== 255) return undefined
    const detail = error.stderrTail.trim().split('\n')[0]
    return `The connection to ${this.host.label} dropped while the repair was running${detail ? ` (${detail})` : ''}. Nothing was promoted, and the original is untouched.`
  }

  /**
   * The ffmpeg run itself: remux or re-encode into the temporary file, with
   * progress, milestones and the timing of the second pass that moves an MP4
   * index. Resolves with the size of what it wrote.
   */
  private async remux(
    id: string,
    result: AnalysisResult,
    finalArgs: string[],
    temporaryPath: string,
    signal: AbortSignal
  ): Promise<number | undefined> {
    // Progress milestones, so a long copy leaves a trail in the log.
    let loggedMilestone = -1
    let announcedFinalise = false
    const ffmpegStarted = performance.now()
    let lastProgressAt = 0
    let finaliseFrom: number | undefined
    let lastSpeed: string | undefined
    // The last figure ffmpeg gave for what it had written. Held against the
    // file system's own answer below, which does not always agree.
    let lastBytesWritten: number | undefined

    await runFfmpeg({
      ffmpegPath: this.binaries.ffmpegPath,
      args: finalArgs,
      durationSeconds: result.file.durationSeconds,
      expectedBytes: result.file.sizeBytes,
      signal,
      spawn: (command, commandArgs) => this.host.spawnProcess(command, commandArgs),
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
        if (progress.bytesWritten != null) lastBytesWritten = progress.bytesWritten
        // Everything after the last byte is reported is the finalising pass,
        // which is where an MP4 index move hides.
        if (finaliseFrom == null && progress.fraction >= 0.999) {
          finaliseFrom = performance.now()
          // ffmpeg reports nothing during the index move, so the step itself
          // is the only sign that anything is still happening.
          if (result.plan.faststart) this.setStage(id, 'finalising')
        }

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

    const outputBytes = await this.settledSize(id, temporaryPath, lastBytesWritten)
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
    return outputBytes
  }

  /**
   * How big the output actually is, once the file system agrees with ffmpeg.
   *
   * A write to a network share is not finished when the process that made it
   * exits: the redirector still has pages to flush, and until it has, the
   * share answers questions about the file from a view that is behind. A
   * 13 GB remux once came back measured at 4.77 GB a fraction of a second
   * after ffmpeg had reported writing 11.5 GB of it — not a short file, a
   * stale answer, and the repair was condemned on the strength of it.
   *
   * ffmpeg's own running total is the second opinion. It only ever counts
   * bytes it has handed over, and the index move that follows rewrites them
   * rather than adding more, so the finished file cannot honestly be smaller
   * than the last figure ffmpeg gave. Smaller means the share is still
   * catching up, so it is asked again.
   */
  private async settledSize(id: string, path: string, reportedBytes: number | undefined): Promise<number | undefined> {
    let size = (await this.host.stat(path))?.sizeBytes
    if (reportedBytes == null || reportedBytes <= 0) return size

    for (const pause of SETTLE_PAUSES_MS) {
      if ((size ?? 0) >= reportedBytes) return size
      await delay(pause)
      size = (await this.host.stat(path))?.sizeBytes
    }

    if ((size ?? 0) < reportedBytes) {
      this.log(
        id,
        'warn',
        'The file system reports less than ffmpeg says it wrote',
        `ffmpeg wrote   ${formatBytes(reportedBytes)}\non disk        ${formatBytes(size ?? 0)}\n\n` +
          'On a network share this is usually the share still catching up rather than a short file, ' +
          'and the check that follows may fail for the same reason. Repairing to a local disk and ' +
          'moving the result afterwards avoids it.'
      )
    }
    return size
  }

  /**
   * Probe the output, with a second and third go at it.
   *
   * ffmpeg exiting is not the same as the output being readable. Across a
   * network share the index can be visible while the data behind it is not,
   * and ffprobe asked at that moment reads a file that does not add up: its
   * decoders complain about data that is not there yet and it refuses the
   * file. Waiting a moment and asking again costs seconds against a copy that
   * took a quarter of an hour, and the alternative is throwing that copy away
   * over a question asked too early.
   *
   * A genuinely broken output fails every attempt and is still refused — this
   * buys it a few seconds, not the benefit of the doubt.
   */
  private async verifyOutput(id: string, temporaryPath: string, signal: AbortSignal): Promise<MediaFile> {
    let lastError: unknown
    for (let attempt = 0; attempt <= VERIFY_RETRY_PAUSES_MS.length; attempt += 1) {
      if (attempt > 0) {
        const pause = VERIFY_RETRY_PAUSES_MS[attempt - 1]
        this.log(
          id,
          'warn',
          `The output did not read back cleanly; trying again in ${Math.round(pause / 1000)}s`,
          `${lastError instanceof Error ? lastError.message : String(lastError)}\n\n` +
            'A file just written across a network share is not always readable the instant the write ends.'
        )
        await delay(pause)
        if (signal.aborted) throw new Error('Cancelled')
      }
      try {
        const probed = await probeFile(temporaryPath, {
          ffprobePath: this.binaries.ffprobePath,
          host: this.host
        })
        if (attempt > 0) this.log(id, 'info', `The output read back cleanly on attempt ${attempt + 1}`)
        return probed
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error
      }
    }
    throw lastError
  }

  /**
   * Move the index with qt-faststart, when that is the whole repair.
   *
   * Resolves with the re-probed output when it worked. When it did not — it
   * failed, declined (it exits 0 without writing anything when the last atom
   * is not `moov`), or wrote something that does not match the source — the
   * temporary file is discarded and it resolves with nothing, so the caller
   * falls back to ffmpeg. Only cancellation throws.
   */
  private async moveIndexWithQtFaststart(
    id: string,
    result: AnalysisResult,
    command: string[],
    temporaryPath: string,
    signal: AbortSignal
  ): Promise<MediaFile | undefined> {
    const [qtFaststartPath, input] = command as [string, string, string]
    this.log(id, 'info', 'Moving the index with qt-faststart (one pass, no remux)', quoteCommand(command))
    this.log(id, 'info', 'Writing to a temporary file first', temporaryPath)

    const sourceBytes = result.file.sizeBytes
    let loggedMilestone = -1
    const started = performance.now()
    let problem: string | undefined

    try {
      await runQtFaststart({
        qtFaststartPath,
        input,
        output: temporaryPath,
        signal,
        spawn: (binary, binaryArgs) => this.host.spawnProcess(binary, binaryArgs),
        onAbort: () => void this.host.kill(temporaryPath),
        // It reports nothing while it runs; the output growing is the progress.
        onTick: () => {
          void this.host
            .stat(temporaryPath)
            .then((info) => {
              const job = this.jobs.get(id)
              if (!info || !job || job.state !== 'running' || !sourceBytes) return
              const fraction = Math.min(0.99, info.sizeBytes / sourceBytes)
              this.update({ ...job, progress: { fraction, bytesWritten: info.sizeBytes } })
              const milestone = Math.floor(fraction * 10) * 10
              if (milestone > loggedMilestone && milestone < 100) {
                loggedMilestone = milestone
                this.log(id, 'info', `${milestone}% copied`, `${formatBytes(info.sizeBytes)} written`)
              }
            })
            .catch(() => undefined)
        }
      })
    } catch (error) {
      if (signal.aborted) throw new Error('Cancelled')
      problem =
        error instanceof QtFaststartError
          ? `${error.message}${error.outputTail ? `\n\n${error.outputTail}` : ''}`
          : error instanceof Error
            ? error.message
            : String(error)
    }
    const ms = performance.now() - started
    if (signal.aborted) throw new Error('Cancelled')

    let probed: MediaFile | undefined
    if (!problem) {
      const info = await this.host.stat(temporaryPath).catch(() => undefined)
      // A refusal exits 0 having written nothing; its reason is in the output.
      if (!info) problem = 'it wrote no output (it declines files whose last top-level atom is not the index)'
    }
    if (!problem) {
      this.setStage(id, 'verifying')
      const verifyStarted = performance.now()
      try {
        probed = await probeFile(temporaryPath, {
          ffprobePath: this.binaries.ffprobePath,
          host: this.host
        })
        problem = indexMoveMismatch(result.file, probed)
      } catch (error) {
        problem = `the output could not be read back (${error instanceof Error ? error.message : String(error)})`
      }
      this.addPhase(id, 'verify', performance.now() - verifyStarted)
    }

    if (problem || !probed) {
      await discardTemporary(temporaryPath, this.host)
      this.log(id, 'warn', 'qt-faststart could not move the index; using ffmpeg instead', problem)
      this.setStage(id, 'copying')
      return undefined
    }

    const outputBytes = probed.sizeBytes
    this.addPhase(id, 'qt-faststart', ms, {
      bytes: outputBytes,
      note: 'one read and one write; no remux and no second pass'
    })
    this.mergeMetrics(id, {
      outputBytes,
      mbPerSecond: outputBytes && ms > 0 ? outputBytes / (1024 * 1024) / (ms / 1000) : undefined
    })
    this.log(id, 'info', 'qt-faststart finished; the index is now at the front')
    return probed
  }

  /**
   * Measure the planned subtitle tracks against the audio and retime them.
   *
   * Returns the tracks whose cues actually moved, as `.srt` files for the
   * repair command to map in place of the originals. A track already in step
   * is not in the list: the repair copies it across untouched, which is both
   * faster and the only honest thing to do with a subtitle that was right.
   *
   * Nothing here is fatal. A measurement that cannot be made — no speech
   * found, a track ffmpeg will not decode, a film too short to correlate —
   * leaves the track exactly as it was and says so in the log. A repair is not
   * worth failing over a subtitle.
   */
  /**
   * Rewrite a Dolby Vision profile 7 video stream as single-layer profile 8.1.
   *
   * Two programs, wired together: ffmpeg copies the video track out of the
   * film as a raw HEVC elementary stream, and `dovi_tool` reads that stream,
   * discards the enhancement layer and rewrites the RPU. The picture is never
   * decoded by either of them, so this costs one read of the file rather than
   * the hours a re-encode would.
   *
   * They are piped rather than run one after the other, which is the whole
   * reason `spawnPipeline` exists. With a file between them a 60 GB remux
   * would need 55 GB of scratch for the extracted stream *before* the
   * conversion had written anything, on top of the 55 GB the converted stream
   * takes and the 60 GB the output takes. Piped, the first of those three
   * never exists.
   *
   * Nothing here is fatal, and that is deliberate: the plan that asked for
   * this also lists the Dolby Vision finding as answered, so a conversion that
   * cannot run has to stop the repair rather than quietly produce a file that
   * still has the problem. It therefore throws, and the caller reports it like
   * any other failure, with the original untouched.
   */
  private async convertDolbyVision7(
    jobId: string,
    result: AnalysisResult,
    signal: AbortSignal
  ): Promise<{ streamIndex: number; path: string; frameRate?: number } | undefined> {
    const spec = result.plan.dolbyVision7To81
    if (!spec || signal.aborted) return undefined

    const doviToolPath = this.binaries.doviToolPath
    if (!doviToolPath) {
      throw new Error(
        'Converting Dolby Vision profile 7 needs dovi_tool, which is not available here. ' +
          'Run "npm run fetch:ffmpeg" in a development checkout, or turn the conversion off under Compatibility.'
      )
    }
    const spawnPipeline = this.host.spawnPipeline
    if (!spawnPipeline) {
      throw new Error(
        `The file is on ${this.host.label}, and converting Dolby Vision profile 7 needs two programs piped ` +
          'together — which only runs on this machine. Copy the file here, or turn the conversion off ' +
          'under Compatibility.'
      )
    }

    this.setStage(jobId, 'dolby-vision')
    const started = performance.now()

    const paths = this.host.paths
    // Beside the file being written rather than beside the film: this is a
    // working file, and the folder the film is in may be read-only.
    const converted = paths.join(
      paths.dirname(result.file.path),
      `.plexfixer-dovi-${Date.now()}.hevc`
    )

    this.log(
      jobId,
      'info',
      'Converting the Dolby Vision stream to profile 8.1',
      'The enhancement layer is discarded and the metadata rewritten. The picture is copied through, not ' +
        're-encoded.\n\nThis needs scratch space about the size of the film\u2019s video track, beside the ' +
        'file, for as long as the repair runs.'
    )

    const stages = [
      {
        command: this.binaries.ffmpegPath,
        args: [
          '-nostdin',
          '-v',
          'error',
          '-i',
          result.file.path,
          '-map',
          `0:${spec.sourceStreamIndex}`,
          '-c:v',
          'copy',
          // dovi_tool reads Annex B; an MP4 source carries length-prefixed
          // NAL units, and without this it sees nothing it recognises.
          '-bsf:v',
          'hevc_mp4toannexb',
          '-f',
          'hevc',
          '-'
        ]
      },
      {
        command: doviToolPath,
        // Mode 2 is "convert the RPU to be profile 8.1 compatible"; --discard
        // drops the enhancement layer, which is what makes the result single
        // layer rather than simply relabelled.
        args: ['-m', '2', 'convert', '--discard', '-', '-o', converted]
      }
    ]

    const process = spawnPipeline(stages)
    const errors: string[] = []
    process.onStderr((chunk) => {
      errors.push(chunk)
      // Only the tail is worth keeping: dovi_tool draws a progress bar.
      if (errors.length > 40) errors.splice(0, errors.length - 40)
    })

    const onAbort = (): void => process.terminate()
    signal.addEventListener('abort', onAbort, { once: true })
    let ended: { code: number | null; signalName?: string }
    try {
      ended = await process.closed
    } finally {
      signal.removeEventListener('abort', onAbort)
    }

    if (signal.aborted) {
      await this.host.remove(converted).catch(() => {})
      return undefined
    }

    if (ended.code !== 0) {
      await this.host.remove(converted).catch(() => {})
      const tail = errors.join('').trim()
      throw new Error(
        `Converting the Dolby Vision stream failed (exit ${ended.code ?? 'unknown'})` +
          (tail ? `: ${tail.slice(-800)}` : '.')
      )
    }

    // dovi_tool exits 0 on an empty input, so the file is checked rather than
    // assumed: muxing a zero-byte video track would produce a file with no
    // picture and ffmpeg would not necessarily complain.
    const info = await this.host.stat(converted).catch(() => undefined)
    if (!info || info.sizeBytes === 0) {
      await this.host.remove(converted).catch(() => {})
      throw new Error('Converting the Dolby Vision stream produced nothing. The file has not been touched.')
    }

    const elapsed = performance.now() - started
    this.addPhase(jobId, 'dolby-vision', elapsed, { bytes: info.sizeBytes })
    this.log(
      jobId,
      'info',
      `Converted the Dolby Vision stream in ${(elapsed / 1000).toFixed(1)}s`,
      `${converted}\n${(info.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB of single-layer HEVC, muxed back in ` +
        'place of the original track.'
    )

    return { streamIndex: spec.sourceStreamIndex, path: converted, frameRate: spec.frameRate }
  }

  private async retimeSubtitles(
    jobId: string,
    result: AnalysisResult,
    settings: AppSettings,
    signal: AbortSignal
  ): Promise<{ streamIndex: number; path: string }[]> {
    const wanted = result.plan.resyncSubtitles
    if (wanted.length === 0 || signal.aborted) return []

    const paths = this.host.paths
    const duration = result.file.durationSeconds ?? 0
    const audio = result.file.streams.find((stream) => stream.kind === 'audio')
    if (!audio || duration <= 0) {
      this.log(
        jobId,
        'info',
        'Subtitle timing was not checked',
        !audio
          ? 'There is no audio track to compare the lines against.'
          : 'The file does not report a duration, and the comparison needs one.'
      )
      return []
    }

    this.setStage(jobId, 'subtitles')
    const started = performance.now()

    // The tracks come out beside the file being written, not beside the film:
    // these are working files, and the folder the film is in may be read-only
    // or somebody else's.
    const scratch = paths.join(paths.dirname(result.file.path), `.plexfixer-subtitles-${Date.now()}`)
    const targets = wanted.map((streamIndex) => ({
      streamIndex,
      outputPath: paths.join(scratch, `track-${streamIndex}.srt`)
    }))

    const retimed: { streamIndex: number; path: string }[] = []
    try {
      await this.host.mkdirp(scratch)
      const read = await this.readSubtitleTracks(jobId, result.file.path, targets, signal)
      if (read.length === 0 || signal.aborted) return []

      const speech = await listenForSpeech({
        ffmpegPath: this.binaries.ffmpegPath,
        sourcePath: result.file.path,
        streamIndex: audio.index,
        durationSeconds: duration,
        spawn: (command, args) => this.host.spawnProcess(command, args),
        signal,
        onAbort: () => void this.host.kill(result.file.path).catch(() => undefined)
      })
      if (signal.aborted) return []

      for (const target of read) {
        const cues = await this.readCues(target.outputPath)
        if (cues.length === 0) continue

        const report = analyseSync(cues, speech, duration * 1000, {
          toleranceMs: settings.subtitleSyncToleranceMs
        })
        // `mismatched` is the subtitle for another cut of the film, and
        // `unknown` means the measurement could not be made. Moving the lines
        // on either verdict would be guessing with somebody's file.
        if (report.state !== 'offset' && report.state !== 'drifting') {
          this.log(
            jobId,
            'info',
            `Subtitle track ${target.streamIndex} was left as it is`,
            `${report.summary} (${report.confidence} confidence)`
          )
          continue
        }
        if (report.confidence === 'poor') {
          this.log(
            jobId,
            'warn',
            `Subtitle track ${target.streamIndex} looks out of step, but not clearly enough to move`,
            `${report.summary}\n\nIt was carried across unchanged. The Subtitles panel can retime it by hand.`
          )
          continue
        }

        const moved = applySync(cues, report)
        await this.writeText(target.outputPath, formatSrt(moved))
        retimed.push({ streamIndex: target.streamIndex, path: target.outputPath })
        this.log(jobId, 'info', `Retimed subtitle track ${target.streamIndex}`, report.summary)
      }
    } catch (error) {
      if (!signal.aborted) {
        this.log(
          jobId,
          'warn',
          'Subtitle timing could not be checked',
          `${describeFfmpegFailure(error)}\n\nThe tracks were carried across as they are; nothing was lost.`
        )
      }
      return []
    } finally {
      this.addPhase(jobId, 'subtitles', performance.now() - started, {
        note: `${retimed.length} of ${wanted.length} retimed`
      })
    }

    return retimed
  }

  /** Cut the chosen tracks out to .srt, together if possible, singly if not. */
  private async readSubtitleTracks(
    jobId: string,
    sourcePath: string,
    targets: readonly { streamIndex: number; outputPath: string }[],
    signal: AbortSignal
  ): Promise<{ streamIndex: number; outputPath: string }[]> {
    // One run over the film reads all of them: ffmpeg reads an input once and
    // demuxes it to as many outputs as it is given.
    try {
      await runFfmpeg({
        ffmpegPath: this.binaries.ffmpegPath,
        args: buildSubtitleReadCommand(sourcePath, targets),
        signal,
        spawn: (binary, binaryArgs) => this.host.spawnProcess(binary, binaryArgs)
      })
      return [...targets]
    } catch (error) {
      if (signal.aborted) return []
      // One track ffmpeg will not decode fails the whole run, and the run
      // cannot say which. Trying them separately costs a read each, which only
      // happens when something is already wrong.
      this.log(
        jobId,
        'info',
        'Reading the subtitle tracks in one pass did not work, so they are being read one at a time',
        describeFfmpegFailure(error)
      )
      const done: { streamIndex: number; outputPath: string }[] = []
      const byOutput = new Map(targets.map((target) => [target.outputPath, target]))
      for (const command of buildSubtitleReadCommands(sourcePath, targets)) {
        if (signal.aborted) break
        const target = byOutput.get(command.outputPath)
        if (!target) continue
        try {
          await runFfmpeg({
            ffmpegPath: this.binaries.ffmpegPath,
            args: command.args,
            signal,
            spawn: (binary, binaryArgs) => this.host.spawnProcess(binary, binaryArgs)
          })
          done.push(target)
        } catch (singleError) {
          this.log(
            jobId,
            'warn',
            `Subtitle track ${target.streamIndex} could not be read, so its timing was not checked`,
            describeFfmpegFailure(singleError)
          )
        }
      }
      return done
    }
  }

  /** A small text file the host wrote, back as cues; empty when unreadable. */
  private async readCues(path: string): Promise<Cue[]> {
    try {
      const stat = await this.host.stat(path)
      if (!stat || stat.sizeBytes === 0) return []
      const bytes = await this.host.readRange(path, 0, stat.sizeBytes)
      return parseCues(decodeSubtitleBytes(bytes)).cues
    } catch {
      return []
    }
  }

  private async writeText(path: string, text: string): Promise<void> {
    await this.host.writeRange(path, 0, new TextEncoder().encode(text))
  }
}

/** What went wrong, in whatever detail the failure carried. */
function describeFfmpegFailure(error: unknown): string {
  if (error instanceof FfmpegError) {
    return `exit code ${error.exitCode ?? 'unknown'}\n\n${error.stderrTail}`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * How long to let a network share catch up with a finished write.
 *
 * Short, and only paid when the share and ffmpeg disagree: a local disk
 * answers correctly first time and never waits at all.
 */
const SETTLE_PAUSES_MS = [500, 1500, 3000]

/**
 * How long to wait before asking again whether the output reads back.
 *
 * Measured against the thing it protects: a remux of a large file over a slow
 * link runs for minutes, so a few seconds spent making sure before discarding
 * it is not a cost worth optimising.
 */
const VERIFY_RETRY_PAUSES_MS = [2000, 5000]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const BACKUP_LABEL = '.plexfixer-backups'

/**
 * Whether the only thing a job would change is the file's name.
 *
 * Only ever true for in-place output. Writing beside the original, or into an
 * output folder, is a request for a *second* file — the original stays where
 * it is — and a rename does not produce one.
 */
function onlyTheName(settings: AppSettings, sourcePath: string, outputPath: string): boolean {
  return settings.outputPlacement === 'in-place' && outputPath !== sourcePath
}

/**
 * Why a file with no plan is being put down untouched.
 *
 * "Already Plex-ready" is only one of the reasons, and it is the wrong one for
 * a file whose scan found a blocker — a Dolby Vision profile 7 file came back
 * from Force transcode saying it was already Plex-ready, directly underneath
 * the blocker that says it is not. The queue is where that claim is read, so
 * the queue is where it has to be true.
 */
function nothingToDo(result: AnalysisResult): {
  message: string
  text: string
  detail?: string
  outcome: JobOutcome
} {
  const blocking = blockingFindings(result)
  if (blocking.length > 0) {
    const lead = blocking[0]
    const rest = blocking.length > 1 ? ` (and ${blocking.length - 1} more)` : ''
    return {
      outcome: 'blocked',
      message: `No repair fixes this — ${lead.title}${rest}`,
      text: `nothing here is automatically repairable — ${lead.title}${rest}`,
      detail:
        blocking.map((finding) => `${finding.title}\n    ${finding.detail}`).join('\n\n') +
        '\n\nThe file was not touched. Open its row in the library for what you can do about this.'
    }
  }

  if (result.findings.length > 0) {
    return {
      outcome: 'already-right',
      message: 'Nothing to change — the notes on this file need no repair',
      text: 'nothing to change',
      detail:
        `${result.findings.length} note${result.findings.length === 1 ? '' : 's'} were recorded for this file, ` +
        'none of which call for the file to be rewritten.'
    }
  }

  return { outcome: 'already-right', message: 'Already Plex-ready — nothing to change', text: 'already Plex-ready' }
}

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
