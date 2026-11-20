/**
 * Codec profiles: the variants of a codec that consumer hardware skips.
 */

import type { CheckModule } from '../framework.js'
import { H264_SAFE_PROFILES, HEVC_SAFE_PROFILES } from '../../rules.js'
import type { Finding } from '../../../types.js'

export const videoProfile: CheckModule = {
  id: 'check.video-profile',
  title: 'Video codec profile',
  summary: 'Profiles outside what consumer decoders implement, 10-bit H.264 above all',
  whatItDoes:
    'A codec is not one thing. H.264 and HEVC each come in profiles, and a decoder chip implements some of ' +
    'them and not others. The one that catches people out is 10-bit H.264 — "High 10" — which has no consumer ' +
    'hardware decoder anywhere, so every client transcodes it on the CPU even though the file says H.264.',
  howItWorks:
    'Compares the profile the file reports against the set consumer hardware actually implements: Baseline, ' +
    'Main and High for H.264, and Main and Main 10 for HEVC. High 10 is called out separately because it also ' +
    'forces the pixel format to change in any re-encode.',
  ifDisabled:
    'A 10-bit H.264 file will be reported as perfectly good H.264, and will transcode on the server for every ' +
    'client that plays it.',
  raises: ['video-high10-profile', 'video-codec-limited'],

  run({ video }) {
    const stream = video[0]
    if (!stream) return {}

    const codec = stream.codec.toLowerCase()
    const profile = (stream.profile ?? '').toLowerCase()
    const findings: Finding[] = []
    let needsPixelFormatChange = false
    let needsTranscode = false

    if (codec === 'h264' && profile.includes('10')) {
      // 10-bit H.264 ("High 10") has no consumer hardware decoder at all.
      needsTranscode = true
      needsPixelFormatChange = true
      findings.push({
        code: 'video-high10-profile',
        severity: 'blocker',
        remedy: 'transcode',
        title: '10-bit H.264 (High 10 profile)',
        detail:
          'No consumer device has a hardware decoder for 10-bit H.264, so every client transcodes it — usually ' +
          'with heavy CPU cost on the server. Re-encoding to 8-bit H.264 or to HEVC Main 10 fixes it.',
        streamIndexes: [stream.index]
      })
    } else if (codec === 'h264' && profile && !H264_SAFE_PROFILES.has(profile)) {
      needsTranscode = true
      findings.push({
        code: 'video-codec-limited',
        severity: 'warning',
        remedy: 'transcode',
        title: `H.264 ${stream.profile} profile`,
        detail: `The ${stream.profile} profile is outside the Baseline/Main/High set that consumer decoders implement.`,
        streamIndexes: [stream.index]
      })
    }

    if ((codec === 'hevc' || codec === 'h265') && profile && !HEVC_SAFE_PROFILES.has(profile)) {
      needsTranscode = true
      findings.push({
        code: 'video-codec-limited',
        severity: 'warning',
        remedy: 'transcode',
        title: `HEVC ${stream.profile} profile`,
        detail: 'Only HEVC Main and Main 10 have broad hardware decoder support.',
        streamIndexes: [stream.index]
      })
    }

    if (findings.length === 0) return {}
    return { findings, signals: { needsTranscode, needsPixelFormatChange } }
  }
}
