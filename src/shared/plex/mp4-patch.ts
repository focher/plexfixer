/**
 * Editing MP4 track metadata in place.
 *
 * Most repairs in a real library are metadata only: a language tag written as
 * `ces` instead of `cze`, a default flag on the wrong track. Remuxing to
 * change them copies every byte of the file — on a 6 GB episode over a
 * network share that is tens of gigabytes of traffic to change four bytes,
 * and it takes minutes.
 *
 * Those fields are fixed-width and live in the `moov` atom, so they can be
 * written straight into the file:
 *
 *   - language sits in `mdhd` as three 5-bit letters packed into two bytes
 *   - the default flag is `track_enabled`, the low bit of the `tkhd` flags
 *
 * Both are same-size edits, so nothing moves and no other byte is touched.
 * Measured against ffmpeg: a language change rewrites exactly 2 bytes and a
 * default moving between tracks exactly 2, with the file size unchanged.
 *
 * Deliberately not handled here:
 *
 *   - the `forced` flag, which ffmpeg stores by adding a box — it grows the
 *     file by 60 bytes, so it is not an in-place edit at all
 *   - the HEVC `hev1`/`hvc1` tag, which also rewrites bits inside `hvcC`;
 *     small, but it changes how a decoder reads the stream, which is not
 *     worth guessing at
 *   - anything that moves the index, drops a track or re-encodes
 *
 * Whatever this module cannot express falls back to the full remux.
 *
 * The bytes come and go through a host rather than a file handle, so this runs
 * wherever the rest of the repair does. It stays a local-only path all the
 * same: the point of it is skipping a copy, and there is no copy to skip when
 * the file is already on the machine doing the work.
 */

import type { RepairHost } from '../host.js'

/** Boxes that contain other boxes and nothing else we need to skip over. */
const MOOV_PATH_DEPTH_LIMIT = 8

export interface Mp4Track {
  /** Position in `moov`, which is also ffprobe's stream index for an MP4. */
  index: number
  /** `vide`, `soun`, `sbtl`, `text`, … */
  handler: string
  /** ISO 639-2 code as stored, or `und`. */
  language: string
  /** Absolute offset of the two-byte packed language in `mdhd`. */
  languageOffset: number
  /** Whether `track_enabled` is set, which is what ffprobe calls `default`. */
  enabled: boolean
  /** Absolute offset of the low byte of the `tkhd` flags. */
  enabledFlagOffset: number
}

export interface BytePatch {
  offset: number
  /** What must currently be there; the write is refused otherwise. */
  expected: Uint8Array
  replacement: Uint8Array
  /** For the job log. */
  description: string
}

interface Box {
  type: string
  /** Offset of the box itself. */
  start: number
  /** Size of the header, 8 or 16. */
  headerSize: number
  /** Total size including the header. */
  size: number
}

/* ------------------------------------------------------------------ *
 * Bytes
 *
 * `DataView` and a couple of helpers rather than `Buffer`: these run in a
 * webview as well as in Node, and big-endian is big-endian everywhere.
 * ------------------------------------------------------------------ */

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** The four-character box types are ASCII; anything else is not a box. */
function latin1(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

/** `cze` -> 0x0F45. Returns undefined for anything not three a–z letters. */
export function packLanguage(code: string): number | undefined {
  const lower = code.toLowerCase()
  if (!/^[a-z]{3}$/.test(lower)) return undefined
  let packed = 0
  for (const char of lower) packed = (packed << 5) | (char.charCodeAt(0) - 0x60)
  return packed & 0x7fff
}

/** 0x0F45 -> `cze`. */
export function unpackLanguage(packed: number): string {
  return [10, 5, 0].map((shift) => String.fromCharCode(((packed >> shift) & 0x1f) + 0x60)).join('')
}

function readBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const data = view(bytes)
  const found: Box[] = []
  let offset = start
  while (offset + 8 <= end) {
    let size = data.getUint32(offset)
    const type = latin1(bytes, offset + 4, offset + 8)
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > end) break
      const large = data.getBigUint64(offset + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break
      size = Number(large)
      headerSize = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < headerSize || offset + size > end) break
    found.push({ type, start: offset, headerSize, size })
    offset += size
  }
  return found
}

function child(bytes: Uint8Array, parent: Box, type: string, depth = 0): Box | undefined {
  if (depth > MOOV_PATH_DEPTH_LIMIT) return undefined
  return readBoxes(bytes, parent.start + parent.headerSize, parent.start + parent.size).find((b) => b.type === type)
}

/** Read `moov` without pulling the whole file in: it may sit at either end. */
async function readMoov(
  path: string,
  size: number,
  host: RepairHost
): Promise<{ bytes: Uint8Array; start: number } | undefined> {
  let offset = 0
  while (offset + 8 <= size) {
    const header = await host.readRange(path, offset, 16)
    if (header.length < 8) return undefined
    const data = view(header)
    let boxSize = data.getUint32(0)
    const type = latin1(header, 4, 8)
    let headerSize = 8
    if (boxSize === 1) {
      if (header.length < 16) return undefined
      const large = data.getBigUint64(8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
      boxSize = Number(large)
      headerSize = 16
    } else if (boxSize === 0) {
      boxSize = size - offset
    }
    if (boxSize < headerSize) return undefined

    if (type === 'moov') {
      // A moov with dozens of tracks is a few megabytes; refuse anything
      // absurd rather than reading a corrupt length into memory.
      if (boxSize > 256 * 1024 * 1024) return undefined
      const bytes = await host.readRange(path, offset, boxSize)
      if (bytes.length < boxSize) return undefined
      return { bytes, start: offset }
    }
    offset += boxSize
  }
  return undefined
}

/**
 * The tracks of an MP4, in the order ffprobe numbers its streams.
 *
 * Undefined when the file is not an MP4 this can safely edit.
 */
export async function readMp4Tracks(path: string, host: RepairHost): Promise<Mp4Track[] | undefined> {
  try {
    const info = await host.stat(path)
    if (!info) return undefined
    const moov = await readMoov(path, info.sizeBytes, host)
    if (!moov) return undefined

    const bytes = moov.bytes
    const data = view(bytes)

    // Offsets inside the buffer are relative to the start of moov.
    const root: Box = {
      type: 'moov',
      start: 0,
      headerSize: data.getUint32(0) === 1 ? 16 : 8,
      size: bytes.length
    }
    const tracks: Mp4Track[] = []

    const traks = readBoxes(bytes, root.headerSize, root.size).filter((b) => b.type === 'trak')
    for (const [index, trak] of traks.entries()) {
      const tkhd = child(bytes, trak, 'tkhd')
      const mdia = child(bytes, trak, 'mdia')
      if (!tkhd || !mdia) return undefined
      const mdhd = child(bytes, mdia, 'mdhd')
      const hdlr = child(bytes, mdia, 'hdlr')
      if (!mdhd || !hdlr) return undefined

      // tkhd is a full box: version(1) flags(3). track_enabled is the low bit.
      const flagsLowByte = tkhd.start + tkhd.headerSize + 3
      const enabled = (bytes[flagsLowByte] & 0x01) !== 0

      // mdhd is a full box too; the timestamps are wider in version 1.
      const version = bytes[mdhd.start + mdhd.headerSize]
      if (version > 1) return undefined
      const languageOffset = mdhd.start + mdhd.headerSize + 4 + (version === 1 ? 28 : 16)
      if (languageOffset + 2 > mdhd.start + mdhd.size) return undefined

      // hdlr: version+flags(4) pre_defined(4) handler_type(4)
      const handlerAt = hdlr.start + hdlr.headerSize + 8
      const handler = latin1(bytes, handlerAt, handlerAt + 4)

      tracks.push({
        index,
        handler,
        language: unpackLanguage(data.getUint16(languageOffset)),
        languageOffset: moov.start + languageOffset,
        enabled,
        enabledFlagOffset: moov.start + flagsLowByte
      })
    }

    return tracks.length > 0 ? tracks : undefined
  } catch {
    return undefined
  }
}

/** The current bytes at each patch site, for checking and for rollback. */
async function readCurrent(path: string, patches: BytePatch[], host: RepairHost): Promise<Uint8Array[]> {
  const current: Uint8Array[] = []
  for (const patch of patches) {
    const bytes = await host.readRange(path, patch.offset, patch.expected.length)
    if (bytes.length !== patch.expected.length) {
      throw new Error(`Could not read ${patch.expected.length} bytes at ${patch.offset}`)
    }
    current.push(bytes)
  }
  return current
}

/**
 * Write the patches, or leave the file exactly as it was.
 *
 * Every site is checked against what it is supposed to contain before
 * anything is written, so a file that changed underneath us is refused rather
 * than corrupted. If a write fails part way the earlier ones are put back.
 */
export async function applyPatches(path: string, patches: BytePatch[], host: RepairHost): Promise<void> {
  if (patches.length === 0) return

  const before = await readCurrent(path, patches, host)
  for (const [i, patch] of patches.entries()) {
    if (!sameBytes(before[i], patch.expected)) {
      throw new Error(
        `${path} does not hold the expected bytes at ${patch.offset} ` +
          `(found ${hex(before[i])}, expected ${hex(patch.expected)}). ` +
          'The file was not modified.'
      )
    }
  }

  const written: number[] = []
  try {
    for (const [i, patch] of patches.entries()) {
      await host.writeRange(path, patch.offset, patch.replacement)
      written.push(i)
    }
  } catch (error) {
    for (const i of written.reverse()) {
      await host.writeRange(path, patches[i].offset, before[i])
    }
    throw error
  }
}

/** Put a file back the way it was, from the bytes a patch replaced. */
export async function revertPatches(path: string, patches: BytePatch[], host: RepairHost): Promise<void> {
  for (const patch of patches) {
    await host.writeRange(path, patch.offset, patch.expected)
  }
}
