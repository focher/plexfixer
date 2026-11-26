/**
 * Every module, in the order it runs.
 *
 * The order is not decoration. Checks are handed what the checks before them
 * concluded, so the ones that decide something — which container the file is
 * headed for, which audio track becomes the default — have to come before the
 * ones that depend on it. Repairs are ordered so that the plan reads the way
 * the work happens: the expensive step first, then the cheap rewrites, then
 * the metadata.
 *
 * Adding a module means adding a file beside the others and a line here. That
 * is the whole of it — nothing else in the app has to know it exists.
 */

import type { CheckModule, RepairModule } from './framework.js'

import { drmProtected } from './checks/drm.js'
import { videoTrackCount } from './checks/video-track-count.js'
import { videoCodec } from './checks/video-codec.js'
import { videoProfile } from './checks/video-profile.js'
import { videoH264Level } from './checks/video-h264-level.js'
import { videoChroma } from './checks/video-chroma.js'
import { videoInterlaced } from './checks/video-interlaced.js'
import { videoDolbyVision } from './checks/video-dolby-vision.js'
import { videoResolution } from './checks/video-resolution.js'
import { videoAnamorphic } from './checks/video-anamorphic.js'
import { videoRefFrames } from './checks/video-ref-frames.js'
import { videoHevcTag } from './checks/video-hevc-tag.js'
import { audioCodec } from './checks/audio-codec.js'
import { audioChannels } from './checks/audio-channels.js'
import { audioCompatibleTrack } from './checks/audio-compatible-track.js'
import { containerTarget } from './checks/container-target.js'
import { containerUnsupported } from './checks/container-unsupported.js'
import { containerMkv } from './checks/container-mkv.js'
import { mp4Faststart } from './checks/mp4-faststart.js'
import { subtitleImage } from './checks/subtitle-image.js'
import { subtitleStyled } from './checks/subtitle-styled.js'
import { subtitleMp4Storage } from './checks/subtitle-mp4-storage.js'
import { trackLanguageMissing } from './checks/track-language-missing.js'
import { trackLanguageNonstandard } from './checks/track-language-nonstandard.js'
import { trackAudioMissing } from './checks/track-audio-missing.js'
import { trackDefaultAudio } from './checks/track-default-audio.js'
import { trackDefaultSubtitle } from './checks/track-default-subtitle.js'
import { trackForcedSubtitle } from './checks/track-forced-subtitle.js'
import { metadataMissing } from './checks/metadata-missing.js'

import { transcodeVideo } from './repairs/transcode-video.js'
import { rewrapContainer } from './repairs/rewrap-container.js'
import { moveIndexToFront } from './repairs/move-index-to-front.js'
import { retagHevc } from './repairs/retag-hevc.js'
import { relabelH264Level } from './repairs/relabel-h264-level.js'
import { mp4SubtitleDefault } from './repairs/mp4-subtitle-default.js'
import { dropUnstorableSubtitles } from './repairs/drop-unstorable-subtitles.js'
import { dropExtraVideo } from './repairs/drop-extra-video.js'
import { customRequests } from './repairs/custom-requests.js'
import { addCompatibilityAudio } from './repairs/add-compatibility-audio.js'
import { replaceIncompatibleAudio } from './repairs/replace-incompatible-audio.js'
import { convertStyledSubtitles } from './repairs/convert-styled-subtitles.js'
import { resyncSubtitles } from './repairs/resync-subtitles.js'
import { fixTrackMetadata } from './repairs/fix-track-metadata.js'
import { manualMetadata } from './repairs/manual-metadata.js'
import { dropCoverArt } from './repairs/drop-cover-art.js'

/**
 * The checks, in order.
 *
 * Video first, because whether the video is being re-encoded decides whether a
 * codec MP4 cannot hold actually blocks the move to MP4. Then audio, then the
 * container itself, then the subtitles — which cannot be judged until the
 * container is settled, since what can be stored depends on where it is going.
 * The track metadata comes last and depends on none of it, and what the file
 * says about itself comes after even that, since it is the one check here that
 * is not about playback.
 */
export const CHECK_MODULES: readonly CheckModule[] = [
  drmProtected,
  videoTrackCount,
  videoCodec,
  videoProfile,
  videoH264Level,
  videoChroma,
  videoInterlaced,
  videoDolbyVision,
  videoResolution,
  videoAnamorphic,
  videoRefFrames,
  videoHevcTag,
  audioCodec,
  audioChannels,
  audioCompatibleTrack,
  containerTarget,
  containerUnsupported,
  containerMkv,
  mp4Faststart,
  subtitleImage,
  subtitleStyled,
  subtitleMp4Storage,
  trackLanguageMissing,
  trackLanguageNonstandard,
  trackAudioMissing,
  trackDefaultAudio,
  trackDefaultSubtitle,
  trackForcedSubtitle,
  metadataMissing
]

/**
 * The repairs, in order.
 *
 * The one that withdraws changes runs before the ones that add them, and the
 * companion audio track runs after the track metadata it supersedes. Cover art
 * runs last of all, because whether it is worth mentioning depends on whether
 * the file is being rewritten at all.
 */
export const REPAIR_MODULES: readonly RepairModule[] = [
  transcodeVideo,
  rewrapContainer,
  moveIndexToFront,
  retagHevc,
  relabelH264Level,
  mp4SubtitleDefault,
  dropUnstorableSubtitles,
  dropExtraVideo,
  customRequests,
  addCompatibilityAudio,
  replaceIncompatibleAudio,
  convertStyledSubtitles,
  resyncSubtitles,
  fixTrackMetadata,
  // Last of the repairs that change the plan: a person's own choice beats
  // every rule that had a view about the same track.
  manualMetadata,
  dropCoverArt
]

/** Everything, for the screen that lists them. */
export const ALL_MODULES = [...CHECK_MODULES, ...REPAIR_MODULES]

export function moduleById(id: string): CheckModule | RepairModule | undefined {
  return ALL_MODULES.find((module) => module.id === id)
}
