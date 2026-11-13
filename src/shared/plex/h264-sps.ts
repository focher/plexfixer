/**
 * Reading an H.264 stream's own settings out of its codec configuration.
 *
 * Two numbers matter for whether a level can be relabelled, and ffprobe does
 * not reliably report either:
 *
 * - The reference-frame count (`max_num_ref_frames`). A level's frame buffer
 *   holds only so many frames at a given size — four at 1080p for Level 4.1 —
 *   so a stream that uses more cannot honestly be called 4.1 at all.
 * - The level in the MP4 `avcC` header, which is a separate copy of the one in
 *   the SPS. Tools such as Subler show and edit the header byte; decoders and
 *   Plex read the SPS. When the two disagree, the file looks fixed in one tool
 *   and broken in another.
 *
 * Only as much of the SPS is read as reaches `max_num_ref_frames`.
 */

export interface H264Config {
  /** `AVCLevelIndication` from an avcC header; absent for Annex-B data. */
  headerLevel?: number
  profileIdc: number
  /** `level_idc` from the SPS — the level decoders actually go by. */
  levelIdc: number
  maxNumRefFrames: number
}

/** Profiles whose SPS carries chroma format, bit depth and scaling lists. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

/** The NAL payload without emulation-prevention bytes (00 00 03 → 00 00). */
function unescape(nal: Uint8Array): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return Uint8Array.from(out)
}

class BitReader {
  private position = 0
  constructor(private readonly bytes: Uint8Array) {}

  bit(): number {
    const byte = this.bytes[this.position >> 3]
    if (byte === undefined) throw new RangeError('ran out of bits')
    const value = (byte >> (7 - (this.position & 7))) & 1
    this.position++
    return value
  }

  bits(count: number): number {
    let value = 0
    for (let index = 0; index < count; index++) value = value * 2 + this.bit()
    return value
  }

  /** Unsigned Exp-Golomb. */
  ue(): number {
    let zeros = 0
    while (this.bit() === 0) {
      zeros++
      if (zeros > 31) throw new RangeError('malformed Exp-Golomb code')
    }
    return 2 ** zeros - 1 + this.bits(zeros)
  }

  /** Signed Exp-Golomb. */
  se(): number {
    const code = this.ue()
    return code % 2 === 1 ? (code + 1) / 2 : -(code / 2)
  }
}

/** Walk one scaling list without keeping it; only its length in bits matters here. */
function skipScalingList(reader: BitReader, size: number): void {
  let last = 8
  let next = 8
  for (let index = 0; index < size; index++) {
    if (next !== 0) next = (last + reader.se() + 256) % 256
    last = next === 0 ? last : next
  }
}

/** The fields up to `max_num_ref_frames` of one SPS NAL unit (header byte included). */
export function parseSps(nal: Uint8Array): Omit<H264Config, 'headerLevel'> | undefined {
  if (nal.length < 4 || (nal[0]! & 0x1f) !== 7) return undefined
  try {
    const reader = new BitReader(unescape(nal.subarray(1)))
    const profileIdc = reader.bits(8)
    reader.bits(8) // constraint flags
    const levelIdc = reader.bits(8)
    reader.ue() // seq_parameter_set_id

    if (HIGH_PROFILES.has(profileIdc)) {
      const chromaFormat = reader.ue()
      if (chromaFormat === 3) reader.bit() // separate_colour_plane_flag
      reader.ue() // bit_depth_luma_minus8
      reader.ue() // bit_depth_chroma_minus8
      reader.bit() // qpprime_y_zero_transform_bypass_flag
      if (reader.bit() === 1) {
        // seq_scaling_matrix_present_flag: 6 lists of 4×4, then 2 (or 6) of 8×8.
        const lists = chromaFormat === 3 ? 12 : 8
        for (let index = 0; index < lists; index++) {
          if (reader.bit() === 1) skipScalingList(reader, index < 6 ? 16 : 64)
        }
      }
    }

    reader.ue() // log2_max_frame_num_minus4
    const pocType = reader.ue()
    if (pocType === 0) {
      reader.ue() // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      reader.bit() // delta_pic_order_always_zero_flag
      reader.se() // offset_for_non_ref_pic
      reader.se() // offset_for_top_to_bottom_field
      const cycle = reader.ue()
      if (cycle > 255) return undefined
      for (let index = 0; index < cycle; index++) reader.se()
    } else if (pocType !== 2) {
      return undefined
    }

    const maxNumRefFrames = reader.ue()
    if (maxNumRefFrames > 16) return undefined
    return { profileIdc, levelIdc, maxNumRefFrames }
  } catch {
    return undefined
  }
}

/** NAL units in Annex-B data, split on 00 00 01 / 00 00 00 01 start codes. */
function annexBUnits(bytes: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = []
  let start = -1
  for (let index = 0; index + 2 < bytes.length; index++) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      if (start >= 0) units.push(bytes.subarray(start, index))
      start = index + 3
      index += 2
    }
  }
  if (start >= 0 && start < bytes.length) units.push(bytes.subarray(start))
  // A four-byte start code leaves a trailing zero on the unit before it.
  return units.map((unit) => {
    let end = unit.length
    while (end > 0 && unit[end - 1] === 0) end--
    return unit.subarray(0, end)
  })
}

/**
 * The first SPS in a stream's codec configuration: an avcC record (MP4 and
 * Matroska) or Annex-B NAL units (MPEG-TS and raw streams).
 */
export function parseH264Config(bytes: Uint8Array): H264Config | undefined {
  if (bytes.length < 8) return undefined

  if (bytes[0] === 1) {
    // avcC: version, profile, compatibility, level, length size, SPS count,
    // then each SPS as a 16-bit length and the NAL unit.
    const headerLevel = bytes[3]!
    const count = bytes[5]! & 0x1f
    if (count === 0) return undefined
    const length = (bytes[6]! << 8) | bytes[7]!
    if (8 + length > bytes.length) return undefined
    const sps = parseSps(bytes.subarray(8, 8 + length))
    return sps ? { headerLevel, ...sps } : undefined
  }

  for (const unit of annexBUnits(bytes)) {
    if (unit.length > 0 && (unit[0]! & 0x1f) === 7) return parseSps(unit)
  }
  return undefined
}

/** The bytes in ffprobe's `-show_data` hex dump ("00000000: 0164 0029 …  .d.)"). */
export function parseHexDump(dump: string): Uint8Array {
  const bytes: number[] = []
  for (const line of dump.split('\n')) {
    const match = /^[0-9a-f]{8}:\s((?:[0-9a-f]{2,4}\s?)+)/i.exec(line.trim())
    if (!match) continue
    // The hex column is groups of up to four digits; the ASCII column follows
    // after two spaces, so stop there.
    const hex = match[1]!.split('  ')[0]!.replace(/\s+/g, '')
    for (let index = 0; index + 1 < hex.length; index += 2) bytes.push(parseInt(hex.slice(index, index + 2), 16))
  }
  return Uint8Array.from(bytes)
}
