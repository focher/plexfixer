/**
 * Which line of a failed command's output gets quoted.
 *
 * Written from a real report: a 13 GB remux ran for thirteen minutes, was
 * refused at the final check, and the reason given was an AAC decoder warning
 * — the first line ffprobe printed — while the sentence naming the actual
 * fault sat on the line below and never reached anyone.
 */

import { describe, expect, it } from 'vitest'
import { summarizeToolFailure } from '@shared/plex/tool-failure.js'

const REAL_FAILURE = [
  'C:\\Users\\USER\\AppData\\Local\\PlexFixer\\resources\\bin\\win32-x64\\ffprobe.exe exited with an error (exit 1):',
  '[aac @ 000001bbc3e450c0] skip_data_stream_element: Input buffer exhausted before END element found',
  'Z:\\Movies\\Train Dreams (2025)\\film.m4v: Invalid data found when processing input'
].join('\n')

describe('summarizing what a tool printed when it failed', () => {
  it('quotes the verdict, not the decoder warning above it', () => {
    expect(summarizeToolFailure(REAL_FAILURE)).toBe(
      'Z:\\Movies\\Train Dreams (2025)\\film.m4v: Invalid data found when processing input'
    )
  })

  it('skips every decoder line, however many there are', () => {
    const output = [
      'ffprobe exited with an error (exit 1):',
      '[aac @ 0x1] channel element 2.5 is not allocated',
      '[eac3 @ 0x2] invalid bitstream id',
      '[eac3 @ 0x2] unable to determine channel mode',
      'film.m4v: Invalid data found when processing input'
    ].join('\n')
    expect(summarizeToolFailure(output)).toBe('film.m4v: Invalid data found when processing input')
  })

  it('falls back to a decoder line when that is all there is', () => {
    const output = ['ffprobe exited with an error (exit 1):', '[aac @ 0x1] Error decoding AAC frame header.'].join('\n')
    expect(summarizeToolFailure(output)).toBe('[aac @ 0x1] Error decoding AAC frame header.')
  })

  it('never answers with the heading while there is anything underneath it', () => {
    const output = 'ffprobe exited with an error (exit 1):\n[aac @ 0x1] Reserved bit set.'
    expect(summarizeToolFailure(output)).not.toContain('exited with an error')
  })

  it('uses the heading when it is the only thing said', () => {
    expect(summarizeToolFailure('ffprobe would not start:')).toBe('ffprobe would not start:')
  })

  it('takes the last line when nothing looks like a verdict', () => {
    expect(summarizeToolFailure('one\ntwo\nthree')).toBe('three')
  })

  it('ignores blank lines and surrounding space', () => {
    expect(summarizeToolFailure('  first  \n\n\n   second   \n')).toBe('second')
  })

  it('says so rather than returning nothing', () => {
    expect(summarizeToolFailure('')).toBe('it printed nothing')
    expect(summarizeToolFailure('\n  \n')).toBe('it printed nothing')
  })

  it('treats a single plain line as the answer', () => {
    expect(summarizeToolFailure('film.m4v: Invalid data found when processing input')).toBe(
      'film.m4v: Invalid data found when processing input'
    )
  })
})
