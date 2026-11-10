/**
 * Reading an FFmpeg build's licence out of the binary.
 *
 * Every FFmpeg build embeds its configure line as a plain string, so what it
 * was built with can be read without running it. One flag decides whether a
 * build may be shipped at all: `--enable-nonfree` produces a binary that is
 * free to use and illegal to redistribute, and nothing about the file says so.
 * PlexFixer 0.1.1 shipped one inside a published macOS DMG.
 *
 * Both the fetch script and the packaging hook use this, so a nonfree build is
 * refused when it arrives and, if one is already sitting in `resources/bin`,
 * again at the moment it would be packaged.
 */

import { open } from 'node:fs/promises'

const CHUNK = 4 * 1024 * 1024
/** Enough to cover a configure line split across two reads. */
const OVERLAP = 8192
/** Comfortably longer than any real configure line. */
const WINDOW = 64 * 1024

const CONFIGURE_LINE = /--prefix=\S*(?:[ \t]--[a-z0-9=\-_/.]+)+/

/** The `--prefix=... --enable-... ` line, or undefined if there is none. */
export async function readConfiguration(path) {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(size, CHUNK))
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead <= 0) break
      const match = CONFIGURE_LINE.exec(buffer.toString('latin1', 0, bytesRead))
      if (match) {
        // The line may run past the end of this chunk, in which case the match
        // is a truncated prefix of it — and a truncated configure line is
        // worse than none, because the flag that matters may be in the part
        // that was cut off. Re-read from where it starts.
        const start = offset + match.index
        const window = Buffer.alloc(Math.min(WINDOW, size - start))
        const read = await handle.read(window, 0, window.length, start)
        const full = CONFIGURE_LINE.exec(window.toString('latin1', 0, read.bytesRead))
        return full ? full[0] : match[0]
      }
      offset += Math.max(1, bytesRead - OVERLAP)
    }
    return undefined
  } finally {
    await handle.close()
  }
}

/**
 * Whether this build may be redistributed.
 *
 * `unknown` when the configure line cannot be found — a judgement is not made
 * on a binary that cannot be read, but the caller is told so it can say.
 */
export async function licenseOf(path) {
  const configuration = await readConfiguration(path)
  if (!configuration) return { redistributable: 'unknown' }
  if (configuration.includes('--enable-nonfree')) {
    return { redistributable: false, reason: '--enable-nonfree', configuration }
  }
  return {
    redistributable: true,
    license: configuration.includes('--enable-gpl')
      ? configuration.includes('--enable-version3')
        ? 'GPL v3 or later'
        : 'GPL v2 or later'
      : configuration.includes('--enable-version3')
        ? 'LGPL v3 or later'
        : 'LGPL v2.1 or later',
    configuration
  }
}
