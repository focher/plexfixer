/**
 * Reading the reference-frame count and both copies of the level out of an
 * H.264 codec configuration. Waterworld's avcC and an x264 Baseline encode
 * are real, as ffprobe dumps them; the scaling-list SPS is built by hand.
 */

import { describe, expect, it } from 'vitest'
import { parseH264Config, parseHexDump, parseSps } from '@shared/plex/h264-sps.js'

// Waterworld (1995).m4v: the avcC header says Level 4.1, its SPS says 5.0.
const WATERWORLD =
  '\n00000000: 0164 0029 ffe1 0019 6764 0032 acca 601e  .d.)....gd.2..`.\n' +
  '00000010: 0083 b011 0000 0303 e900 00bb 808f 1831  ...............1\n' +
  '00000020: 9a01 0004 68e9 7bcb fdf8 f800            ....h.{.....\n'

// x264 Baseline, -refs 3: no chroma or scaling-list fields in the SPS.
const BASELINE =
  '00000000: 0142 c00d ffe1 0018 6742 c00d d901 41fb  .B......gB....A.\n' +
  '00000010: 0110 0000 0300 1000 0003 0300 f142 a480  .............B..\n' +
  '00000020: 0100 0568 cb83 cb20                      ...h... \n'

/** Bits, written MSB first, for building an SPS by hand. */
class BitWriter {
  private readonly bits: number[] = []
  put(value: number, count: number): this {
    for (let index = count - 1; index >= 0; index--) this.bits.push((value >> index) & 1)
    return this
  }
  ue(value: number): this {
    const code = value + 1
    const length = Math.floor(Math.log2(code))
    return this.put(0, length).put(code, length + 1)
  }
  se(value: number): this {
    return this.ue(value > 0 ? 2 * value - 1 : -2 * value)
  }
  bytes(): Uint8Array {
    const bits = [...this.bits, 1] // rbsp_stop_one_bit
    while (bits.length % 8 !== 0) bits.push(0)
    return Uint8Array.from({ length: bits.length / 8 }, (_, index) =>
      bits.slice(index * 8, index * 8 + 8).reduce((byte, bit) => byte * 2 + bit, 0)
    )
  }
}

/**
 * A High-profile SPS with scaling lists in it, which x264 never writes there
 * (it puts its matrices in the PPS): one 4×4 list given in full, one 8×8 list
 * that switches to the default after a single value, and 3 reference frames.
 */
function spsWithScalingLists(): Uint8Array {
  const writer = new BitWriter()
    .put(100, 8) // profile_idc: High
    .put(0, 8) // constraint flags
    .put(40, 8) // level_idc
    .ue(0) // seq_parameter_set_id
    .ue(1) // chroma_format_idc: 4:2:0
    .ue(0) // bit_depth_luma_minus8
    .ue(0) // bit_depth_chroma_minus8
    .put(0, 1) // qpprime_y_zero_transform_bypass_flag
    .put(1, 1) // seq_scaling_matrix_present_flag
  for (let list = 0; list < 8; list++) {
    if (list === 0) {
      writer.put(1, 1)
      for (let entry = 0; entry < 16; entry++) writer.se(entry % 2 === 0 ? 3 : -1)
    } else if (list === 6) {
      writer.put(1, 1).se(-8) // next becomes 0: use the default matrix
    } else {
      writer.put(0, 1)
    }
  }
  writer
    .ue(0) // log2_max_frame_num_minus4
    .ue(0) // pic_order_cnt_type
    .ue(2) // log2_max_pic_order_cnt_lsb_minus4
    .ue(3) // max_num_ref_frames
    .put(0, 1) // gaps_in_frame_num_value_allowed_flag
  return Uint8Array.from([0x67, ...writer.bytes()])
}

describe('parseHexDump', () => {
  it('reads the hex column and ignores the ASCII one', () => {
    const bytes = parseHexDump(WATERWORLD)
    expect(bytes.length).toBe(44)
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x01, 0x64, 0x00, 0x29])
    expect(bytes.at(-1)).toBe(0x00)
  })
})

describe('parseH264Config', () => {
  it('reads Waterworld: header 4.1, stream 5.0, five reference frames', () => {
    expect(parseH264Config(parseHexDump(WATERWORLD))).toEqual({
      headerLevel: 41,
      profileIdc: 100,
      levelIdc: 50,
      maxNumRefFrames: 5
    })
  })

  it('reads the same SPS from Annex-B data, where there is no header level', () => {
    const avcc = parseHexDump(WATERWORLD)
    const length = (avcc[6]! << 8) | avcc[7]!
    const annexB = Uint8Array.from([0, 0, 0, 1, ...avcc.subarray(8, 8 + length), 0, 0, 0, 1, 0x68, 0xe9])
    expect(parseH264Config(annexB)).toEqual({ profileIdc: 100, levelIdc: 50, maxNumRefFrames: 5 })
  })

  it('reads a Baseline SPS, which has no high-profile fields', () => {
    expect(parseH264Config(parseHexDump(BASELINE))).toMatchObject({ profileIdc: 66, maxNumRefFrames: 3 })
  })

  it('walks past scaling lists to the reference-frame count', () => {
    expect(parseSps(spsWithScalingLists())).toEqual({ profileIdc: 100, levelIdc: 40, maxNumRefFrames: 3 })
  })

  it('gives up on anything it cannot read, rather than guessing', () => {
    expect(parseH264Config(Uint8Array.from([]))).toBeUndefined()
    expect(parseH264Config(parseHexDump(WATERWORLD).subarray(0, 12))).toBeUndefined()
    expect(parseH264Config(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeUndefined()
    // Not an SPS at all (a PPS).
    expect(parseSps(Uint8Array.from([0x68, 0xe9, 0x7b, 0xcb]))).toBeUndefined()
  })
})
