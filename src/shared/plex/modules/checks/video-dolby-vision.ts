/**
 * Dolby Vision without an HDR10 fallback.
 */

import type { CheckModule } from '../framework.js'
import { DOLBY_VISION_SAFE_PROFILES } from '../../rules.js'

export const videoDolbyVision: CheckModule = {
  id: 'check.video-dolby-vision',
  title: 'Dolby Vision fallback',
  summary: 'Dolby Vision that looks wrong on clients which cannot decode it',
  whatItDoes:
    'Dolby Vision comes in several profiles, and they do not all degrade the same way. The good ones carry an ' +
    'ordinary HDR10 picture underneath, so a client that cannot do Dolby Vision simply plays the HDR10 and ' +
    'nobody notices. Profile 5 does not: there is no picture underneath, and a client that cannot decode it ' +
    'renders the raw data as the familiar green-and-purple mess rather than failing honestly.',
  howItWorks:
    'Reads the Dolby Vision profile number and compares it against the ones that fall back cleanly (8.1 and ' +
    '8.4). Profile 5 can be converted: the Dolby Vision layer is applied to the picture and the result written ' +
    'as plain HDR10, which looks right everywhere — switched on under Compatibility. Profile 7 carries a second ' +
    'enhancement layer, which is a different problem and not one ffmpeg solves, so it stays a manual fix.',
  ifDisabled:
    'A profile 5 file will be reported as ordinary HEVC, and will keep showing badly skewed colours on every ' +
    'client without a Dolby Vision decoder.',
  raises: ['video-dolby-vision-profile'],

  run({ video, settings }) {
    const stream = video[0]
    if (!stream || stream.dolbyVisionProfile == null) return {}
    if (DOLBY_VISION_SAFE_PROFILES.has(stream.dolbyVisionProfile)) return {}

    // Profile 5 is the one with a conversion that actually works: libplacebo
    // applies the RPU and writes the picture out as HDR10. Rewriting the
    // metadata alone would relabel the file 8.1 and leave every colour wrong,
    // because the base layer is IPT-PQ-C2 rather than BT.2020. Profile 7's
    // problem is an enhancement layer — a different job, and not one ffmpeg
    // does — so it stays a manual fix whatever this setting says.
    const converting = stream.dolbyVisionProfile === 5 && settings.dolbyVision5 === 'hdr10'

    return {
      signals: converting ? { needsTranscode: true, convertDolbyVision: true } : undefined,
      findings: [
        {
          code: 'video-dolby-vision-profile',
          severity: 'blocker',
          remedy: converting ? 'transcode' : 'manual',
          title: `Dolby Vision profile ${stream.dolbyVisionProfile} without an HDR10 fallback`,
          detail:
            stream.dolbyVisionProfile === 5
              ? 'Profile 5 is single-layer Dolby Vision with no HDR10 base layer. Clients that cannot decode Dolby ' +
                'Vision render it with badly skewed colours (the familiar green/purple cast) rather than falling ' +
                'back gracefully. ' +
                (converting
                  ? 'A repair re-encodes it to plain HDR10 through libplacebo: the Dolby Vision layer goes, and ' +
                    'the picture looks right everywhere.'
                  : 'Converting to plain HDR10 is the reliable fix — turn it on under Compatibility.')
              : 'This Dolby Vision profile carries an enhancement layer that most clients ignore or mis-handle. ' +
                'Profiles 8.1 and 8.4 degrade cleanly; this one does not.',
          streamIndexes: [stream.index]
        }
      ]
    }
  }
}
