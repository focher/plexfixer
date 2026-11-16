/**
 * What a repaired file has to look like before it may replace its source.
 *
 * ffmpeg can exit 0 on a file that is not what was asked for, and promotion
 * moves the original aside — so this is the last point at which a bad output
 * costs nothing.
 */

import { describe, expect, it } from 'vitest'
import type { MediaFile } from '@shared/types.js'
import { outputProblem } from '@shared/plex/verify.js'

function file(kinds: ('video' | 'audio' | 'subtitle')[], durationSeconds?: number): MediaFile {
  return { durationSeconds, streams: kinds.map((kind, index) => ({ kind, index })) } as unknown as MediaFile
}

describe('outputProblem', () => {
  it('accepts an output with the same streams and length', () => {
    expect(outputProblem(file(['video', 'audio'], 5400), file(['video', 'audio'], 5400))).toBeUndefined()
  })

  it('refuses an output with no video', () => {
    expect(outputProblem(file(['video', 'audio'], 5400), file(['audio'], 5400))).toMatch(/missing streams/)
  })

  it('refuses an output that lost its audio', () => {
    expect(outputProblem(file(['video', 'audio'], 5400), file(['video'], 5400))).toMatch(/missing streams/)
  })

  it('accepts a silent film staying silent', () => {
    expect(outputProblem(file(['video'], 5400), file(['video'], 5400))).toBeUndefined()
  })

  it('refuses an output that stops early', () => {
    // Ninety minutes in, twelve out. Both streams are there, which is all
    // that used to be checked.
    const problem = outputProblem(file(['video', 'audio'], 5400), file(['video', 'audio'], 720))
    expect(problem).toMatch(/stops early/)
    expect(problem).toContain('12:00')
    expect(problem).toContain('1:30:00')
  })

  it('allows for the way containers round', () => {
    // A remux moves the end by a frame or a trailing subtitle; a few seconds
    // either way in an hour and a half is not a truncated file.
    expect(outputProblem(file(['video', 'audio'], 5400), file(['video', 'audio'], 5391.4))).toBeUndefined()
    expect(outputProblem(file(['video', 'audio'], 5400), file(['video', 'audio'], 5402))).toBeUndefined()
  })

  it('does not judge a clip too short for a tenth to mean anything', () => {
    expect(outputProblem(file(['video', 'audio'], 20), file(['video', 'audio'], 17))).toBeUndefined()
  })

  it('does not guess when either length is unknown', () => {
    expect(outputProblem(file(['video', 'audio']), file(['video', 'audio'], 10))).toBeUndefined()
    expect(outputProblem(file(['video', 'audio'], 5400), file(['video', 'audio']))).toBeUndefined()
  })
})
