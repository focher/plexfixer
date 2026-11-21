/**
 * Re-encoding the video, which is the expensive repair and the last resort.
 */

import type { RepairModule } from '../framework.js'
import type { VideoTranscodeSpec } from '../../../types.js'

export const transcodeVideo: RepairModule = {
  id: 'repair.transcode-video',
  title: 'Re-encode video',
  summary: 'Encodes the picture again, once, so it never has to be encoded again',
  whatItDoes:
    'Encodes the video again into a format every client can play. This is the only repair that touches the ' +
    'picture itself, and the only one that takes real time — minutes to hours for one film. It exists because ' +
    'the alternative is the server doing the same work, worse, every time anybody presses play.',
  howItWorks:
    'Runs when a check has concluded the video cannot be played as it is: an undecodable codec, a profile no ' +
    'hardware implements, a level too high to relabel, 4:2:2 colour, or interlaced fields. The target codec ' +
    'and quality come from Transcoding, and hardware encoding is used where the machine has it. Everything ' +
    'the checks asked for happens in the same pass — deinterlacing, downscaling, converting to 8-bit — ' +
    'because a second pass would mean encoding twice. Dolby Vision profile 5 is the exception that names its ' +
    'own codec: it has to come out as 10-bit HEVC or the conversion would be pointless.',
  ifDisabled:
    'Nothing is ever re-encoded. Files that genuinely cannot direct play are still reported, and still ' +
    'listed as unresolved, but no repair will be offered for them — which is a reasonable way to run a ' +
    'library you only ever want remuxed.',
  answers: [
    'video-codec-unsupported',
    'video-codec-limited',
    'video-high10-profile',
    'video-chroma-unsupported',
    'video-interlaced',
    'video-resolution-high',
    'video-anamorphic',
    'video-refframes-high',
    'video-dolby-vision-profile'
  ],

  run({ video, settings, state }) {
    if (!state.needsTranscode) return {}
    const source = video[0]
    if (!source) return {}

    const convertDolbyVision = state.convertDolbyVision

    // HDR10 is 10-bit BT.2020 PQ, which H.264 cannot carry: converting Dolby
    // Vision to it and then flattening the result to 8-bit would throw away the
    // very thing the conversion is for. So the conversion names its own codec
    // and keeps the depth, whatever the transcode setting says.
    const videoTranscode: VideoTranscodeSpec = {
      sourceStreamIndex: source.index,
      codec: convertDolbyVision ? 'hevc' : settings.transcodeVideoCodec,
      deinterlace: state.needsDeinterlace,
      scaleHeight: state.scaleHeight,
      // HEVC Main 10 can carry 10-bit; H.264 cannot, so anything above
      // 8-bit has to be converted when targeting H.264.
      forceYuv420p:
        !convertDolbyVision &&
        (state.needsPixelFormatChange ||
          settings.transcodeVideoCodec === 'h264' ||
          (source.bitDepth ?? 8) > 10),
      dolbyVisionToHdr10: convertDolbyVision || undefined,
      quality: settings.videoQuality
    }

    const action = convertDolbyVision
      ? {
          label: 'Convert Dolby Vision profile 5 to HDR10',
          detail:
            'The Dolby Vision RPU is applied to the picture and the result is written as HEVC Main 10 in BT.2020 ' +
            'PQ. The Dolby Vision layer is not carried over — that is the point: an HDR10 file looks right on ' +
            'every client, where profile 5 only looks right on a Dolby Vision one.'
        }
      : {
          label: `Re-encode video to ${settings.transcodeVideoCodec === 'hevc' ? 'HEVC Main 10' : 'H.264 High @ 8-bit'}`,
          detail:
            `The current video stream cannot be direct played. Re-encoding to ${settings.transcodeVideoCodec === 'hevc' ? 'HEVC Main 10' : 'H.264 High @ 8-bit'} makes it play natively on ` +
            'every client, at the cost of one encode now.'
        }

    return { strategy: 'transcode-video', actions: [action], plan: { videoTranscode } }
  }
}
