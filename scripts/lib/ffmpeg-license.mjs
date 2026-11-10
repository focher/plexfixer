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
 *
 * The line is found by the marker FFmpeg itself prints — `configuration: ` —
 * and then read to the end of the C string. An earlier version instead matched
 * the flags with a regex, which was wrong in both directions: it read nothing
 * at all from a build configured without `--prefix`, and on a build whose
 * `--extra-version` held a quoted URL it stopped at the quote and reported the
 * truncated prefix. That prefix happened to omit `--enable-gpl`, so a GPL
 * build was reported as LGPL — and a line truncated before `--enable-nonfree`
 * would have been reported as shippable. Nothing is returned here unless the
 * whole NUL-terminated string was seen.
 */

import { open } from 'node:fs/promises'

const CHUNK = 4 * 1024 * 1024
/** Longest line considered; real configure lines run to one or two KB. */
const MAX_LINE = 16 * 1024
/** Overlap so a marker cannot be missed by falling across a chunk edge. */
const OVERLAP = MAX_LINE + 64
/** What `ffmpeg -version` prints in front of the flags. */
const MARKER = 'configuration: '

/** The configure line, or undefined if the binary does not carry a whole one. */
export async function readConfiguration(path) {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(size, CHUNK))
    let offset = 0
    // Builds differ in how the banner is stored. Some hold the marker and the
    // flags as one literal, so the flags follow the marker; others print them
    // with `"%sconfiguration: %s"`, which leaves the flags as a string of
    // their own somewhere else entirely. The marker is the reliable anchor
    // when it is there, so a free-standing line is only fallen back on once
    // the whole file has failed to produce a marked one.
    let unmarked
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead <= 0) break
      const text = buffer.toString('latin1', 0, bytesRead)
      for (let at = text.indexOf(MARKER); at >= 0; at = text.indexOf(MARKER, at + 1)) {
        // The marker may sit near the end of this chunk with the flags running
        // past it, so the string is re-read from the file rather than sliced
        // out of the chunk.
        const line = await stringAt(handle, size, offset + at + MARKER.length)
        if (line) return line
      }
      unmarked ??= await findUnmarked(handle, size, text, offset)
      offset += Math.max(1, bytesRead - OVERLAP)
    }
    return unmarked
  } finally {
    await handle.close()
  }
}

/**
 * A configure line stored without the marker in front of it.
 *
 * Every `--enable-`/`--disable-` in the chunk is a candidate, and most are
 * help text for some encoder's options, so each is widened to the whole
 * NUL-terminated string it sits in and then put through the same check.
 */
async function findUnmarked(handle, size, text, offset) {
  const flags = /--(?:enable|disable)-/g
  let match
  while ((match = flags.exec(text)) != null) {
    const from = text.lastIndexOf('\0', match.index) + 1
    if (from === 0 || match.index - from > MAX_LINE) continue
    const line = await stringAt(handle, size, offset + from)
    if (line) return line
  }
  return undefined
}

/**
 * The NUL-terminated string starting at `start`, if it looks like a configure
 * line. Undefined when the terminator is not within reach, so a line that was
 * cut short is never mistaken for a complete one.
 */
async function stringAt(handle, size, start) {
  const window = Buffer.alloc(Math.min(MAX_LINE, size - start))
  const { bytesRead } = await handle.read(window, 0, window.length, start)
  const text = window.toString('latin1', 0, bytesRead)
  const end = text.indexOf('\0')
  if (end < 0) return undefined
  const line = text.slice(0, end).trim()
  if (!line.startsWith('-')) return undefined
  if (!/--(?:enable|disable)-/.test(line)) return undefined
  if (/[^\x20-\x7e]/.test(line)) return undefined
  return line
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
