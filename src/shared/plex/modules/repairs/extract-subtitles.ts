/**
 * Writing subtitles out beside the film as plain text files.
 */

import { defineRepair } from '../framework.js'
import { STYLED_SUBTITLE_CODECS, isTextSubtitle } from '../../rules.js'
import { normalizeLanguage } from '../../../languages.js'
import type { SubtitleStream } from '../../../types.js'

export const extractSubtitles = defineRepair({
  id: 'repair.extract-subtitles',
  title: 'Extract subtitles to sidecar files',
  summary: 'Writes .srt files beside the video, which clients render for free',
  whatItDoes:
    'Writes subtitle tracks out as plain .srt files sitting beside the film. Plex picks up sidecar files ' +
    'automatically and every client renders plain text without the server doing any work — which is the whole ' +
    'point, because the tracks this rescues are the ones that would otherwise have been painted into the ' +
    'picture.',
  howItWorks:
    'With "Extract text subtitles" on under Compatibility, it takes two kinds of track by itself: the styled ' +
    'ones, whose fonts and positioning clients cannot reproduce, and any text track about to be left out ' +
    'because the target container has nowhere to put it. A track a rule you wrote asked for is written out ' +
    'whether that setting is on or not — you asked. Picture subtitles are never written out this way: there ' +
    'is no text in them to write. The file name carries the language, and forced tracks are marked, so Plex ' +
    'files them correctly.',
  ifDisabled:
    'No sidecar files are written. Styled subtitles keep forcing a burn-in, and text tracks dropped for the ' +
    'container are simply gone.',
  answers: ['subtitle-styled-ass'],
  answersRules: true,

  params: {
    extractText: {
      type: 'boolean',
      label: 'Extract text subtitles to .srt sidecars',
      help: 'Sidecar SRT never triggers a burn-in transcode.'
    }
  },

  run({ subtitles, state, params }) {
    // Worth extracting without being asked: anything text-based that either
    // will be dropped, or is styled (and so would be burned in rather than
    // rendered). And then whatever a rule explicitly asked for.
    const dropped = new Set(state.dropStreams)
    const asked = new Set(state.extractSubtitles.map((stream) => stream.index))

    const extract: SubtitleStream[] = []
    for (const stream of subtitles) {
      // There is no text in a picture subtitle to write into an .srt.
      if (!isTextSubtitle(stream.codec)) continue
      if (asked.has(stream.index)) {
        extract.push(stream)
        continue
      }
      if (!params.extractText) continue
      const isStyled = STYLED_SUBTITLE_CODECS.has(stream.codec.toLowerCase())
      if (isStyled || dropped.has(stream.index)) extract.push(stream)
    }
    if (extract.length === 0) return {}

    return {
      plan: {
        extractSubtitles: extract.map((s) => ({
          streamIndex: s.index,
          language: normalizeLanguage(s.language),
          forced: s.disposition.forced
        }))
      },
      actions: [
        {
          label: `Extract ${extract.length} subtitle track${extract.length === 1 ? '' : 's'} to .srt sidecars`,
          detail:
            'Sidecar SRT files are rendered as text by every Plex client, so they never trigger a burn-in transcode.'
        }
      ]
    }
  }
})
