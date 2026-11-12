/**
 * Where a repair has got to, for the indicator in the queue.
 *
 * ffmpeg's percentage covers one step of several. On a local disk the others
 * go by too fast to notice; on another machine they do not — connecting,
 * re-probing a finished file over the link, moving it into place across
 * volumes — and a bar stuck at 100% with no explanation is indistinguishable
 * from a repair that has died.
 */

import type { Job, JobStage } from './types.js'

export const STAGE_ORDER: JobStage[] = [
  'waiting',
  'connecting',
  'planning',
  'copying',
  'finalising',
  'verifying',
  'promoting',
  'subtitles',
  'finished'
]

export const STAGE_LABEL: Record<JobStage, string> = {
  waiting: 'Waiting',
  connecting: 'Connecting',
  planning: 'Planning',
  copying: 'Copying',
  finalising: 'Index',
  verifying: 'Verifying',
  promoting: 'Moving',
  subtitles: 'Subtitles',
  finished: 'Done'
}

/** The longer form, for a tooltip or a line of text. */
export const STAGE_DETAIL: Record<JobStage, string> = {
  waiting: 'Queued, waiting for a slot',
  connecting: 'Reaching the machine that holds the file',
  planning: 'Working out what to run',
  copying: 'ffmpeg is copying the file',
  finalising: 'Moving the MP4 index to the front — a second pass over the whole file',
  verifying: 'Re-probing the output to confirm it has the streams it should',
  promoting: 'Backing up the original and moving the repaired file into place',
  subtitles: 'Writing subtitle sidecars',
  finished: 'Finished'
}

/**
 * The steps always worth drawing.
 *
 * Everything else — the index move, subtitle sidecars — only appears once a
 * job has actually reached it, because whether it happens at all depends on
 * the file.
 */
const BACKBONE: JobStage[] = ['connecting', 'copying', 'verifying', 'promoting']

export interface StageStep {
  stage: JobStage
  label: string
  state: 'done' | 'active' | 'todo'
}

export function stageIndex(stage: JobStage | undefined): number {
  return stage ? STAGE_ORDER.indexOf(stage) : -1
}

/** The steps to draw for one job, in order, with the current one marked. */
export function stepsFor(job: Job): StageStep[] {
  // A skipped job never started, so it has no steps to show.
  if (job.state === 'skipped') return []
  const current = job.stage
  const position = stageIndex(current)
  const stages = new Set<JobStage>(BACKBONE)
  // A stage this job has been through, or is in, is part of its story even
  // when it is not part of every repair's.
  if (current && current !== 'waiting' && current !== 'finished') stages.add(current)
  if (position >= stageIndex('finalising') && job.metrics?.phases.some((phase) => phase.phase === 'finalise')) {
    stages.add('finalising')
  }
  if (job.metrics?.phases.some((phase) => phase.phase === 'subtitles')) stages.add('subtitles')

  const ordered = STAGE_ORDER.filter((stage) => stages.has(stage))
  const finished = job.state !== 'queued' && job.state !== 'running'

  return ordered.map((stage) => ({
    stage,
    label: STAGE_LABEL[stage],
    state:
      finished
        ? // A job that stopped early did not reach the later steps, and must
          // not claim it did: it stays at the step it died in.
          job.state === 'done' || stageIndex(stage) < position
          ? 'done'
          : 'todo'
        : stageIndex(stage) < position
          ? 'done'
          : stageIndex(stage) === position
            ? 'active'
            : 'todo'
  }))
}

/** How long a running job has been silent, once that is long enough to matter. */
export function stalledSeconds(job: Job, now: number, threshold = 20_000): number | undefined {
  if (job.state !== 'running' || !job.updatedAt) return undefined
  const quiet = now - job.updatedAt
  return quiet >= threshold ? Math.round(quiet / 1000) : undefined
}

/** One line of status for a running job. */
export function describeProgress(job: Job): string {
  if (job.state !== 'running') return STAGE_LABEL[job.stage ?? 'waiting']
  const stage = job.stage ?? 'copying'
  if (stage === 'copying' && job.progress.fraction > 0) {
    return `${STAGE_LABEL[stage]} ${Math.round(job.progress.fraction * 100)}%`
  }
  return STAGE_LABEL[stage]
}
