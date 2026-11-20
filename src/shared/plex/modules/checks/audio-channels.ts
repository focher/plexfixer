/**
 * Channel counts above what clients play without downmixing.
 */

import type { CheckModule } from '../framework.js'
import { MAX_SAFE_CHANNELS } from '../../rules.js'
import type { Finding } from '../../../types.js'

export const audioChannels: CheckModule = {
  id: 'check.audio-channels',
  title: 'Audio channel count',
  summary: 'Tracks with more channels than clients play without downmixing',
  whatItDoes:
    'Finds audio tracks with more channels than the client will be playing back — 7.1 on a device with two ' +
    'speakers, say. The client has to fold those channels down to what it has, and folding them down is a ' +
    'transcode, with everything that implies for a remote connection.',
  howItWorks:
    'Counts the channels and flags anything above 5.1, which is as far as mainstream clients reliably go. ' +
    'Reported for information: the fix is not to throw the surround track away but to add a smaller companion ' +
    'track beside it, which is what the compatibility audio repair does.',
  ifDisabled:
    'Nothing is said about channel counts, so a 7.1 track being downmixed on every play goes unmentioned.',
  raises: ['audio-channels-high'],

  run({ audio }) {
    const findings: Finding[] = []

    for (const stream of audio) {
      if (stream.channels <= MAX_SAFE_CHANNELS) continue
      findings.push({
        code: 'audio-channels-high',
        severity: 'info',
        remedy: 'transcode',
        title: `Audio track #${stream.index}: ${stream.channels} channels`,
        detail:
          `${stream.channelLayout ?? `${stream.channels} channels`} is downmixed by most clients, and any ` +
          'downmix is a transcode. A 5.1 or stereo companion track avoids it.',
        streamIndexes: [stream.index]
      })
    }

    return findings.length > 0 ? { findings } : {}
  }
}
