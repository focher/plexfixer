/**
 * The one thing the track modules share: what language a track will end up in.
 *
 * The language modules run first and write their corrections into the running
 * state. Everything after them — which audio track becomes the default, which
 * subtitle comes up — has to reason about the language a track is *going to*
 * have, not the one it has now, or a file whose tags are being fixed gets its
 * defaults chosen from the tags that are about to be replaced.
 */

import type { AudioStream, SubtitleStream, TrackPlanChange } from '../../../types.js'

export function effectiveLanguage(
  stream: AudioStream | SubtitleStream,
  changes: readonly TrackPlanChange[]
): string {
  const change = changes.find((c) => c.streamIndex === stream.index && c.setLanguage)
  return change?.setLanguage ?? stream.language
}
