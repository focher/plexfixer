/**
 * Why a file is blocked, and what the person looking at it can actually do.
 *
 * "Needs you" on its own is a dead end: the finding says what is wrong, but not
 * why PlexFixer will not deal with it, and those are different questions. A
 * file can be blocked because no tool could fix it (DRM), because fixing it
 * would destroy something (Dolby Vision metadata, picture detail), or because
 * the fix is a setting the user is better placed to decide than the app is.
 *
 * Each entry below answers both halves, and nothing here promises a repair the
 * app would not actually perform — a warning that only a re-encode addresses
 * stays unresolved even in Force transcode, because the plan for such a file is
 * still a stream copy.
 */

import type { AnalysisResult, Finding, FindingCode, RemedyClass } from '../types.js'

export interface BlockedReason {
  code: FindingCode
  severity: Finding['severity']
  /** The finding's own headline. */
  title: string
  /** Why no automatic repair handles it. */
  why: string
  /** The move that is actually open to the user. */
  youCan: string
}

interface Explanation {
  why: string
  youCan: string
}

const BY_CODE: Partial<Record<FindingCode, Explanation>> = {
  'drm-protected': {
    why: 'The file is encrypted. Its streams cannot be copied or re-encoded without the decryption key, so there is nothing any repair tool can do with it.',
    youCan: 'Replace it with a DRM-free copy. Plex cannot direct play this one either.'
  },
  'video-missing': {
    why: 'No video stream was found, so there is no video repair to plan. Everything PlexFixer does assumes a video file.',
    youCan: 'Check the file plays at all. If it is audio-only, it does not belong in a video library; if it does not play, it is damaged.'
  },
  'video-dolby-vision-profile': {
    why: 'Converting this Dolby Vision profile to one that degrades gracefully (8.1) means rewriting the RPU metadata, which ffmpeg alone cannot do. A plain re-encode would silently drop the Dolby Vision layer and shift every colour in the picture.',
    youCan: 'Convert it deliberately with Dolby Vision tooling (dovi_tool and friends), re-encode it to plain HDR10, or keep it and accept that only DV-capable clients render it correctly.'
  },
  'video-resolution-high': {
    why: 'The only way to change this is to re-encode the picture smaller, which throws away detail permanently. PlexFixer will not do that to chase a bandwidth warning, and Force transcode will not either — the plan for this file is a stream copy.',
    youCan: 'Raise the height ceiling in Settings if your clients and your upload can handle it, or keep a separate smaller copy for remote viewing.'
  },
  'video-interlaced': {
    why: 'Deinterlacing is a re-encode: every frame is rebuilt. A stream copy cannot touch it.',
    youCan: 'Set this file or its folder to Force transcode — the re-encode deinterlaces once, instead of Plex doing it on every play.'
  },
  'video-anamorphic': {
    why: 'Non-square pixels are a property of the encoded picture. Correcting the geometry means re-encoding it.',
    youCan: 'Leave it unless a client actually shows it stretched — most honour the aspect metadata.'
  },
  'video-refframes-high': {
    why: 'The reference-frame count is fixed at encode time, so only a re-encode changes it.',
    youCan: 'Leave it unless a particular TV or stick stutters on this file; re-encoding costs more than the problem usually does.'
  },
  'audio-channels-high': {
    why: 'Reducing the channel count means re-encoding the audio, and PlexFixer does not quietly discard channels from your source.',
    youCan: 'Turn on "Always add a stereo AAC track" so a compatible companion track is added alongside the original, and the surround track stays for the clients that can take it.'
  },
  'audio-no-compatible-track': {
    why: 'Nothing in the file is universally playable, and the settings in force do not allow adding a companion track.',
    youCan: 'Turn on "Always add a stereo AAC track" in Settings — the repair then adds an AAC track beside the originals rather than replacing anything.'
  },
  'default-subtitle-unwanted': {
    why: 'MP4 always leaves one subtitle track enabled, so clearing the flag would only move it to another track rather than switch subtitles off.',
    youCan: "Turn subtitles off in the Plex client's own playback settings, which is where that preference actually lives."
  },
  'default-subtitle-language-mismatch': {
    why: 'MP4 always leaves one subtitle track enabled, so this flag cannot simply be cleared in an MP4.',
    youCan: 'Keep the file as MKV if the subtitle default matters, or set the preference in the Plex client.'
  },
  'container-blocked-by-stream': {
    why: 'A stream in this file cannot live in MP4, so the container stays as it is. That is a deliberate choice, not a failure: losing a lossless audio track is worse than a Direct Stream remux.',
    youCan: 'Nothing, unless you would rather drop that stream — the file plays, it just gets remuxed by the server for some clients.'
  }
}

const BY_REMEDY: Record<RemedyClass, Explanation> = {
  manual: {
    why: 'No automatic repair covers this one.',
    youCan: 'Read the finding below and decide: it needs a judgement call or a different tool.'
  },
  transcode: {
    why: 'Only re-encoding the video would change this, and the plan for this file is a stream copy — PlexFixer does not re-encode to clear a warning.',
    youCan: 'Set the file or its folder to Force transcode if you want the re-encode, or leave it: the file still plays.'
  },
  lossless: {
    why: 'This should have been fixed by the repair plan, which means something about the file prevented it.',
    youCan: 'Copy the report from this row and check the plan — this combination is worth looking at.'
  },
  none: {
    why: 'Nothing needs to happen about this.',
    youCan: 'Nothing.'
  }
}

/**
 * Whether an unresolved finding makes the file "blocked".
 *
 * - A blocker nothing resolves: the file will not direct play, and no repair
 *   PlexFixer can run changes that (Dolby Vision profile 5, DRM, no audio).
 * - A warning whose only remedy is manual: something the user has to decide,
 *   e.g. "No English audio track" when the video is tagged English but every
 *   audio track is French — is the video tag wrong, or is a dub missing?
 *
 * A warning that only an optional re-encode would change ("HEVC may not play
 * on every client", interlaced video) is advisory and does not count: it would
 * strand a file with nothing to do as blocked. Info notes never count.
 */
export function needsYou(finding: Finding): boolean {
  if (finding.severity === 'blocker') return true
  return finding.severity === 'warning' && finding.remedy === 'manual'
}

/** The findings that make a file "blocked"; see `needsYou`. */
export function blockingFindings(result: AnalysisResult): Finding[] {
  return result.plan.unresolved.filter(needsYou)
}

export function isBlocked(result: AnalysisResult): boolean {
  return blockingFindings(result).length > 0
}

/** Why each blocking finding has no automatic repair, and the way out of it. */
export function blockedReasons(result: AnalysisResult): BlockedReason[] {
  return blockingFindings(result).map((finding) => {
    const explanation = BY_CODE[finding.code] ?? BY_REMEDY[finding.remedy]
    return {
      code: finding.code,
      severity: finding.severity,
      title: finding.title,
      why: explanation.why,
      youCan: explanation.youCan
    }
  })
}

/** One line for the top of the detail pane, or a tooltip. */
export function blockedSummary(result: AnalysisResult): string | undefined {
  const reasons = blockedReasons(result)
  if (reasons.length === 0) return undefined
  if (reasons.length === 1) return reasons[0]?.title
  return `${reasons.length} things here have no automatic fix: ${reasons.map((reason) => reason.title).join('; ')}`
}
