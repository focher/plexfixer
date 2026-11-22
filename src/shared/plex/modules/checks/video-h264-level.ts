/**
 * The H.264 level: a number a decoder is allowed to refuse outright.
 */

import { defineCheck } from '../framework.js'
import { formatLevel } from '../../rules.js'
import { h264LevelFit } from '../../h264-level.js'

export const videoH264Level = defineCheck({
  id: 'check.video-h264-level',
  title: 'H.264 level',
  summary: 'Streams labelled above the level older clients will accept',
  whatItDoes:
    'Every H.264 stream carries a level number — a promise about how demanding it is. Decoders advertise the ' +
    'highest level they support and simply refuse anything above it, rather than playing it badly. Older Apple ' +
    'TVs, Rokus and smart TVs commonly stop at Level 4.1.',
  howItWorks:
    'Compares the level inside the stream with the ceiling set under Compatibility. When it is too high, it ' +
    'then works out whether the stream genuinely needs that level: resolution, frame rate, reference frames and ' +
    'bitrate are each checked against the lower level’s limits. If they all fit, the label is simply wrong ' +
    'and can be corrected without touching a single frame. If they do not, only a re-encode will do.',
  ifDisabled:
    'Files that older clients will refuse outright are reported as fine, including the common case where the ' +
    'label is wrong and the fix would have been free.',
  raises: ['video-level-too-high'],

  params: {
    maxLevel: {
      type: 'number',
      label: 'Maximum H.264 level',
      help: 'Older Apple TVs, Rokus and smart TVs commonly cap at 4.1.',
      options: [
        { value: 40, label: 'Level 4.0' },
        { value: 41, label: 'Level 4.1' },
        { value: 42, label: 'Level 4.2' },
        { value: 50, label: 'Level 5.0' },
        { value: 51, label: 'Level 5.1' },
        { value: 62, label: 'Level 6.2 (no practical limit)' }
      ]
    }
  },

  run({ video, params }) {
    const stream = video[0]
    if (!stream) return {}
    const codec = stream.codec.toLowerCase()
    if (codec !== 'h264' || stream.level == null || stream.level <= params.maxLevel) return {}

    // The level is a label. When the stream's resolution, frame rate, buffer
    // and bitrate all fit the lower level, correcting the label is lossless.
    const fit = h264LevelFit(stream, stream.level, params.maxLevel)
    const relabel = fit.fits
    const maxLabel = formatLevel(params.maxLevel)
    const streamLabel = formatLevel(stream.level)

    // The MP4 header carries its own copy of the level. When it disagrees with
    // the stream's, a tool that shows the header makes the file look fine.
    const headerNote =
      stream.headerLevel != null && stream.headerLevel !== stream.level
        ? ` The MP4 header says Level ${formatLevel(stream.headerLevel)} — the figure Subler and similar tools show — ` +
          `but the level inside the stream, which players and Plex read, is ${streamLabel}. Changing it in Subler ` +
          'only edits the header.'
        : ''

    return {
      signals: relabel ? { relabelLevel: params.maxLevel } : { needsTranscode: true },
      findings: [
        {
          code: 'video-level-too-high',
          severity: 'warning',
          remedy: relabel ? 'lossless' : 'transcode',
          title: `H.264 Level ${streamLabel} exceeds Level ${maxLabel}`,
          detail:
            'Decoders advertise a maximum level; above it they refuse the stream outright rather than degrading. ' +
            'Older Apple TVs, Rokus and smart TVs commonly cap at Level 4.1.' +
            (relabel
              ? ` This stream's resolution, frame rate${stream.refFrames != null ? `, ${stream.refFrames} reference frames` : ''} ` +
                `and bitrate fit Level ${maxLabel}, so the label is corrected without re-encoding.` +
                (headerNote ||
                  ' Tools such as Subler show the level in the MP4 header, which can be changed separately; ' +
                    'players and Plex read the level inside the stream.')
              : ` It cannot simply be relabelled: the stream ${fit.reason ?? `does not fit Level ${maxLabel}`}, so only a ` +
                `re-encode makes it a true Level ${maxLabel} stream.` +
                headerNote),
          streamIndexes: [stream.index]
        }
      ]
    }
  }
})
