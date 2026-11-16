/**
 * Holding a download to the checksum that was pinned for it.
 *
 * The ffmpeg binaries come from other projects' release pages and go inside an
 * installer that carries this project's signature. Nothing used to check that
 * what arrived was what was expected, and one source was a rolling `latest`
 * tag, which is replaced daily by design — so "whatever is there today" was
 * what got signed. A pinned SHA-256 means a build either ships the bytes that
 * were chosen or stops.
 */

import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'

/**
 * A pass-through stream that hashes what goes through it.
 *
 * In the pipeline rather than a second read of the file afterwards: the bytes
 * hashed are the bytes written, with no window between the two.
 */
export function hashingTap() {
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk)
      done(null, chunk)
    },
  })
  return { tap, digest: () => hash.digest('hex') }
}

/** Throw unless `actual` is the checksum pinned for `name`. */
export function assertChecksum(name, actual, expected) {
  if (!/^[0-9a-f]{64}$/.test(expected ?? '')) {
    throw new Error(
      `${name} has no SHA-256 pinned, so there is nothing to hold the download to.\n` +
        '  Every source in TARGETS needs one: take it from the `digest` GitHub lists\n' +
        '  for the release asset, and pin the release tag it belongs to.',
    )
  }
  if (actual !== expected) {
    throw new Error(
      `${name} is not the file that was pinned.\n` +
        `  expected sha256 ${expected}\n` +
        `  received sha256 ${actual}\n` +
        '  The release asset has changed, or the download was tampered with. Nothing\n' +
        '  was kept. If the source was updated on purpose, pin the new tag and its\n' +
        '  checksum together in scripts/fetch-ffmpeg.mjs.',
    )
  }
}
