/**
 * Doing what a rule the user wrote asked for.
 *
 * A hand-written rule cannot write a file. It can ask for one of the things
 * the app already does, and this is where those asks are turned into the plan
 * — so every ffmpeg command that ever runs was still built by code that ships
 * with the app, whatever anyone types into the editor.
 *
 * Re-encoding is not here: a rule asking for that sets the same flag a built-in
 * check sets, and the built-in re-encode repair picks it up. This one covers
 * the two that have nowhere else to go.
 */

import type { RepairModule } from '../framework.js'
import type { TrackPlanChange } from '../../../types.js'

export const customRequests: RepairModule = {
  id: 'repair.custom-requests',
  title: 'Carry out your own rules',
  summary: 'Performs the fixes rules you wrote asked for',
  whatItDoes:
    'Carries out the repairs asked for by rules you wrote yourself: dropping the tracks a rule matched, and ' +
    'rewriting a file a rule wants rewritten. Each one is credited to the rule that asked for it in the plan, ' +
    'so a track going missing can always be traced back to the line that asked for it.',
  howItWorks:
    'A hand-written rule never describes how a file is written — it names one of the repairs the app already ' +
    'has, and this module turns that into the plan. A track a built-in check is already dropping is not ' +
    'dropped twice. Re-encoding and extracting subtitles are not handled here: a rule asking for those joins ' +
    'the built-in repair that does them, so there is one route to each.',
  ifDisabled:
    'Rules you wrote still report what they find, but the fixes they ask for are not carried out — dropping ' +
    'tracks and rewriting files both stop. Switching this off is the way to run your own rules as warnings ' +
    'only.',
  answers: ['custom'],

  run({ subtitles, audio, state }) {
    if (state.userRequests.length === 0) return {}

    const rewrites: string[] = []
    const trackChanges: TrackPlanChange[] = []
    // A track a built-in check already decided to leave out, so one dropped
    // track never produces two instructions to drop it.
    const alreadyDropped = new Set(state.dropStreams)
    const kindOf = new Map<number, 'audio' | 'subtitle'>([
      ...audio.map((stream) => [stream.index, 'audio'] as const),
      ...subtitles.map((stream) => [stream.index, 'subtitle'] as const)
    ])

    for (const request of state.userRequests) {
      if (request.kind === 'rewrite') {
        if (!rewrites.includes(request.module)) rewrites.push(request.module)
        continue
      }
      for (const index of request.streamIndexes) {
        if (alreadyDropped.has(index)) continue
        const kind = kindOf.get(index)
        if (!kind) continue
        alreadyDropped.add(index)
        trackChanges.push({
          streamIndex: index,
          kind,
          drop: true,
          reason: `Dropped by your rule “${request.module}”`
        })
      }
    }

    const remuxParts = rewrites.map((name) => `rewrite the file, asked for by “${name}”`)
    if (trackChanges.length === 0 && remuxParts.length === 0) return {}

    return {
      strategy: 'remux',
      trackChanges,
      remuxParts
    }
  }
}
