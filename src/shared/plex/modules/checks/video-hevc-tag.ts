/**
 * The four letters that decide whether Apple clients will open an HEVC MP4.
 */

import type { CheckModule } from '../framework.js'
import { preferredHevcTag } from '../../rules.js'

export const videoHevcTag: CheckModule = {
  id: 'check.video-hevc-tag',
  title: 'HEVC codec tag in MP4',
  summary: 'HEVC tagged hev1 instead of hvc1, which Apple clients refuse',
  whatItDoes:
    'Finds HEVC video inside an MP4 that is labelled in the form Apple clients will not touch. There are two ' +
    'ways to store HEVC in an MP4 and they differ only in where some setup data sits; iOS, iPadOS, tvOS and ' +
    'Safari accept one and refuse the file outright with the other. Nothing is wrong with the video itself.',
  howItWorks:
    'Reads the four-letter tag on the video track and compares it with the one the file should carry: hvc1 ' +
    'normally, or dvh1 when the stream is Dolby Vision, so the Dolby Vision signalling survives. Correcting it ' +
    'is a metadata change — not one frame is re-encoded.',
  ifDisabled:
    'HEVC MP4s that Apple devices refuse to play will be reported as healthy, and the free fix will not be ' +
    'offered.',
  raises: ['video-hevc-wrong-tag'],

  run({ video, file }) {
    const stream = video[0]
    if (!stream) return {}
    const codec = stream.codec.toLowerCase()
    if (codec !== 'hevc' && codec !== 'h265') return {}
    if (file.container !== 'mp4' || !stream.codecTag) return {}

    // In MP4, HEVC must carry the `hvc1` codec tag — or `dvh1` when the stream
    // is Dolby Vision. With the in-band form (`hev1`, `dvhe`) Apple clients
    // refuse the file outright, and this is pure metadata, fixed by a remux.
    const wantedTag = preferredHevcTag(stream.codecTag)
    if (stream.codecTag.toLowerCase() === wantedTag) return {}

    return {
      signals: { needsTagFix: true },
      findings: [
        {
          code: 'video-hevc-wrong-tag',
          severity: 'blocker',
          remedy: 'lossless',
          title: `HEVC tagged as "${stream.codecTag}" instead of "${wantedTag}"`,
          detail:
            `Apple clients (iOS, iPadOS, tvOS, Safari) only accept HEVC in MP4 when the codec tag is ${wantedTag}. ` +
            `With ${stream.codecTag} they refuse to play the file at all. This is a metadata-only fix — no ` +
            're-encoding needed.' +
            (wantedTag === 'dvh1'
              ? ' The Dolby Vision tag family is kept, so the stream stays Dolby Vision rather than being '
                + 'presented as ordinary HEVC.'
              : ''),
          streamIndexes: [stream.index]
        }
      ]
    }
  }
}
