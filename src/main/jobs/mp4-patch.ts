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
 */

import { open, type FileHandle } from 'node:fs/promises'

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
  expected: Buffer
  replacement: Buffer
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

function readBoxes(buffer: Buffer, start: number, end: number): Box[] {
  const found: Box[] = []
  let offset = start
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > end) break
      const large = buffer.readBigUInt64BE(offset + 8)
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

function child(buffer: Buffer, parent: Box, type: string, depth = 0): Box | undefined {
  if (depth > MOOV_PATH_DEPTH_LIMIT) return undefined
  return readBoxes(buffer, parent.start + parent.headerSize, parent.start + parent.size).find((b) => b.type === type)
}

/** Read `moov` without pulling the whole file in: it may sit at either end. */
async function readMoov(handle: FileHandle, size: number): Promise<{ buffer: Buffer; start: number } | undefined> {
  const header = Buffer.alloc(16)
  let offset = 0
  while (offset + 8 <= size) {
    const { bytesRead } = await handle.read(header, 0, 16, offset)
    if (bytesRead < 8) return undefined
    let boxSize = header.readUInt32BE(0)
    const type = header.toString('latin1', 4, 8)
    let headerSize = 8
    if (boxSize === 1) {
      if (bytesRead < 16) return undefined
      const large = header.readBigUInt64BE(8)
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
      const buffer = Buffer.alloc(boxSize)
      const read = await handle.read(buffer, 0, boxSize, offset)
      if (read.bytesRead < boxSize) return undefined
      return { buffer, start: offset }
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
export async function readMp4Tracks(path: string): Promise<Mp4Track[] | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const moov = await readMoov(handle, size)
    if (!moov) return undefined

    // Offsets inside the buffer are relative to the start of moov.
    const root: Box = { type: 'moov', start: 0, headerSize: moov.buffer.readUInt32BE(0) === 1 ? 16 : 8, size: moov.buffer.length }
    const tracks: Mp4Track[] = []

    const traks = readBoxes(moov.buffer, root.headerSize, root.size).filter((b) => b.type === 'trak')
    for (const [index, trak] of traks.entries()) {
      const tkhd = child(moov.buffer, trak, 'tkhd')
      const mdia = child(moov.buffer, trak, 'mdia')
      if (!tkhd || !mdia) return undefined
      const mdhd = child(moov.buffer, mdia, 'mdhd')
      const hdlr = child(moov.buffer, mdia, 'hdlr')
      if (!mdhd || !hdlr) return undefined

      // tkhd is a full box: version(1) flags(3). track_enabled is the low bit.
      const flagsLowByte = tkhd.start + tkhd.headerSize + 3
      const enabled = (moov.buffer.readUInt8(flagsLowByte) & 0x01) !== 0

      // mdhd is a full box too; the timestamps are wider in version 1.
      const version = moov.buffer.readUInt8(mdhd.start + mdhd.headerSize)
      if (version > 1) return undefined
      const languageOffset = mdhd.start + mdhd.headerSize + 4 + (version === 1 ? 28 : 16)
      if (languageOffset + 2 > mdhd.start + mdhd.size) return undefined

      // hdlr: version+flags(4) pre_defined(4) handler_type(4)
      const handlerAt = hdlr.start + hdlr.headerSize + 8
      const handler = moov.buffer.toString('latin1', handlerAt, handlerAt + 4)

      tracks.push({
        index,
        handler,
        language: unpackLanguage(moov.buffer.readUInt16BE(languageOffset)),
        languageOffset: moov.start + languageOffset,
        enabled,
        enabledFlagOffset: moov.start + flagsLowByte
      })
    }

    return tracks.length > 0 ? tracks : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/** The current bytes at each patch site, for checking and for rollback. */
async function readCurrent(handle: FileHandle, patches: BytePatch[]): Promise<Buffer[]> {
  const current: Buffer[] = []
  for (const patch of patches) {
    const buffer = Buffer.alloc(patch.expected.length)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, patch.offset)
    if (bytesRead !== buffer.length) throw new Error(`Could not read ${buffer.length} bytes at ${patch.offset}`)
    current.push(buffer)
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
export async function applyPatches(path: string, patches: BytePatch[]): Promise<void> {
  if (patches.length === 0) return
  const handle = await open(path, 'r+')
  try {
    const before = await readCurrent(handle, patches)
    for (const [i, patch] of patches.entries()) {
      if (!before[i].equals(patch.expected)) {
        throw new Error(
          `${path} does not hold the expected bytes at ${patch.offset} ` +
            `(found ${before[i].toString('hex')}, expected ${patch.expected.toString('hex')}). ` +
            'The file was not modified.'
        )
      }
    }

    const written: number[] = []
    try {
      for (const [i, patch] of patches.entries()) {
        await handle.write(patch.replacement, 0, patch.replacement.length, patch.offset)
        written.push(i)
      }
      await handle.sync()
    } catch (error) {
      for (const i of written.reverse()) {
        await handle.write(before[i], 0, before[i].length, patches[i].offset)
      }
      await handle.sync()
      throw error
    }
  } finally {
    await handle.close()
  }
}

/** Put a file back the way it was, from the bytes a patch replaced. */
export async function revertPatches(path: string, patches: BytePatch[]): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    for (const patch of patches) {
      await handle.write(patch.expected, 0, patch.expected.length, patch.offset)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}
