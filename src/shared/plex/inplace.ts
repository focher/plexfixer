/**
 * Deciding whether a repair is only metadata, and so can be written straight
 * into the file instead of rewriting it.
 *
 * This is deliberately strict. Getting it wrong means editing bytes of
 * someone's media in place, so anything not clearly expressible as a
 * fixed-width field edit goes down the ordinary remux path, which copies to a
 * scratch file and re-probes it before replacing anything.
 */

import type { AnalysisResult, TrackPlanChange } from '../types.js'

export type InPlaceRefusal =
  | 'not-mp4'
  | 'container-change'
  | 'not-a-remux'
  | 'needs-reencode'
  | 'adds-audio'
  | 'drops-a-track'
  | 'resyncs-subtitles'
  | 'converts-a-subtitle'
  | 'moves-the-index'
  | 'changes-the-codec-tag'
  | 'changes-the-level'
  | 'changes-a-forced-flag'
  | 'changes-a-track-name'
  | 'changes-the-file-tags'
  | 'nothing-to-do'

/**
 * Why a repair had to copy the file, in the user's terms.
 *
 * A metadata-only change that nevertheless rewrites gigabytes looks like a bug
 * unless the reason is stated, so every refusal has a sentence here and the
 * runner puts it in the job log.
 */
export const REFUSAL_REASON: Record<InPlaceRefusal, string> = {
  'not-mp4': 'the file is not an MP4 — only MP4 headers can be edited in place',
  'container-change': 'the repair changes the container, which means writing a new file',
  'not-a-remux': 'the repair is not a stream copy',
  'needs-reencode': 'the video has to be re-encoded',
  'adds-audio': 'an AAC track is being added, which has to be encoded and written in',
  'drops-a-track': 'a track is being dropped, which means rewriting the file without it',
  'resyncs-subtitles': 'a subtitle track is being retimed, which rewrites its cues',
  'converts-a-subtitle': 'a subtitle track is being rewritten in another format',
  'moves-the-index': 'the MP4 index is at the end of the file and has to be moved to the front, which rewrites every byte',
  'changes-the-codec-tag': 'the video codec tag is changing, which is left to ffmpeg',
  'changes-a-forced-flag': 'a forced-subtitle flag is changing, which makes the header longer',
  'changes-a-track-name': 'a track is being renamed, and a name is not a fixed-width field — the file has to be rewritten',
  'changes-the-file-tags': 'the file\'s own tags are being written, and text of any length cannot be slotted into the header',
  'changes-the-level': 'the H.264 level is being relabelled, which rewrites the stream itself, not just the header',
  'nothing-to-do': 'there is nothing to change'
}

export interface InPlaceVerdict {
  /** The changes to write, when the whole plan is expressible. */
  changes?: TrackPlanChange[]
  /** Why not, otherwise — reported so the behaviour is never a mystery. */
  refusal?: InPlaceRefusal
}

/**
 * Whether this plan is nothing but language tags and default flags.
 *
 * The caller must also be writing back over the original: producing a copy
 * somewhere else is a copy however it is done.
 */
export function inPlaceVerdict(result: AnalysisResult): InPlaceVerdict {
  const { plan, file } = result

  if (file.container !== 'mp4') return { refusal: 'not-mp4' }
  if (plan.targetContainer !== 'mp4') return { refusal: 'container-change' }
  if (plan.strategy !== 'remux') return { refusal: plan.strategy === 'none' ? 'nothing-to-do' : 'not-a-remux' }
  if (plan.videoTranscode || plan.requiresTranscode) return { refusal: 'needs-reencode' }
  if (plan.addCompatibilityAudio) return { refusal: 'adds-audio' }
  if (plan.resyncSubtitles.length > 0) return { refusal: 'resyncs-subtitles' }

  // Moving the index to the front is a rewrite of the whole file by
  // definition; only a file that already has it there can be edited in place.
  if (plan.faststart && file.faststart !== true) return { refusal: 'moves-the-index' }

  // A codec tag change also rewrites bits inside the codec configuration, so
  // it is left to ffmpeg.
  if (plan.videoCodecTag) {
    const primary = file.streams.find((s) => s.kind === 'video')
    const current = primary && 'codecTag' in primary ? primary.codecTag : undefined
    if ((current ?? '').toLowerCase() !== plan.videoCodecTag.toLowerCase()) {
      return { refusal: 'changes-the-codec-tag' }
    }
  }

  // The level lives in the SPS, which can repeat inside the stream; rewriting
  // it is ffmpeg's job, with the usual re-probe before anything is replaced.
  if (plan.videoLevel != null) return { refusal: 'changes-the-level' }

  // Text set by hand is any length, so it cannot be written over what is
  // already there; only fixed-width fields can be edited where they lie.
  if (plan.metadataTags && Object.keys(plan.metadataTags).length > 0) return { refusal: 'changes-the-file-tags' }

  const changes = plan.trackChanges.filter((change) => !change.drop)
  if (changes.length !== plan.trackChanges.length) return { refusal: 'drops-a-track' }
  // ffmpeg stores `forced` by adding a box, which changes the file's length.
  if (changes.some((change) => change.setForced != null)) return { refusal: 'changes-a-forced-flag' }
  if (changes.some((change) => change.setTitle != null)) return { refusal: 'changes-a-track-name' }
  // Rewriting a subtitle's cues or its format replaces the track's payload,
  // which is the opposite of a fixed-width field edit.
  if (changes.some((change) => change.resync)) return { refusal: 'resyncs-subtitles' }
  if (changes.some((change) => change.convertSubtitleTo)) return { refusal: 'converts-a-subtitle' }

  const effective = changes.filter((change) => change.setLanguage != null || change.setDefault != null)
  if (effective.length === 0) return { refusal: 'nothing-to-do' }

  return { changes: effective }
}
