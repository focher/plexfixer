/**
 * The OpenSubtitles file hash.
 *
 * Searching by title is a guess — there are eleven films called *The Promise*
 * and a dozen cuts of some of them, and a subtitle timed against the theatrical
 * release is useless over the extended one. The hash removes the guess: it
 * identifies the exact file, so a match means somebody uploaded a subtitle
 * timed against *this* encode, and the timing is usually right to the frame.
 *
 * It is a cheap hash on purpose, and deliberately not a checksum of the whole
 * file: the size, plus the first 64 KB and the last 64 KB read as little-endian
 * 64-bit integers, all added together and allowed to overflow. Two reads of
 * 64 KB identify a 40 GB file across a network share in milliseconds, which is
 * the only reason this is worth doing at scan time at all.
 *
 * Overflow is the specification, not an accident, so the arithmetic is done in
 * BigInt and masked back to 64 bits at each step. Doing it in doubles loses the
 * low bits and produces a hash that matches nothing.
 */

/** Both ends are read in 64 KB pieces; this is that piece. */
export const HASH_CHUNK_BYTES = 65536

const SIXTY_FOUR_BITS = (1n << 64n) - 1n

/** Sum a buffer as little-endian unsigned 64-bit words, wrapping on overflow. */
function sumWords(bytes: Uint8Array, from: bigint): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let total = from
  // Anything past the last whole word is ignored, exactly as the reference
  // implementation ignores it: the chunks are 64 KB, which divides by eight.
  for (let offset = 0; offset + 8 <= bytes.byteLength; offset += 8) {
    total = (total + view.getBigUint64(offset, true)) & SIXTY_FOUR_BITS
  }
  return total
}

/**
 * The hash, as the sixteen lowercase hex digits the service expects.
 *
 * `head` and `tail` are the first and last 64 KB of the file. They are passed
 * in rather than read here so this stays pure and testable — reading them is
 * the host's job, and the host may be at the far end of an SSH connection.
 */
export function movieHashFrom(sizeBytes: number, head: Uint8Array, tail: Uint8Array): string {
  let hash = BigInt(sizeBytes) & SIXTY_FOUR_BITS
  hash = sumWords(head, hash)
  hash = sumWords(tail, hash)
  return hash.toString(16).padStart(16, '0')
}

/** Just enough of a host to read the two ends of a file. */
export interface HashSource {
  stat: (path: string) => Promise<{ sizeBytes: number } | undefined>
  readRange: (path: string, offset: number, length: number) => Promise<Uint8Array>
}

/**
 * Read a file's two ends and hash it.
 *
 * A file smaller than one chunk has no hash: the algorithm reads 64 KB from
 * each end and a shorter file would have the two reads overlap, which produces
 * a number the service has never seen. Nothing in a Plex library is that small,
 * so this returns undefined rather than inventing something.
 */
export async function movieHash(path: string, host: HashSource): Promise<string | undefined> {
  const stat = await host.stat(path)
  if (!stat || stat.sizeBytes < HASH_CHUNK_BYTES) return undefined

  const head = await host.readRange(path, 0, HASH_CHUNK_BYTES)
  const tail = await host.readRange(path, stat.sizeBytes - HASH_CHUNK_BYTES, HASH_CHUNK_BYTES)
  if (head.byteLength < HASH_CHUNK_BYTES || tail.byteLength < HASH_CHUNK_BYTES) return undefined

  return movieHashFrom(stat.sizeBytes, head, tail)
}
