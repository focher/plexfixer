/**
 * Subtitles that stay in the film.
 *
 * Two things are being guarded, and they are the two that cost a user
 * something real when they are wrong.
 *
 * **Cost.** ffmpeg reads an input once and can demux it to as many outputs as
 * it is given, and one run can write several tracks back. Reading three tracks
 * out of a 4.6 GB film a track at a time is fourteen gigabytes of reading for
 * a few hundred kilobytes of text; writing them back a track at a time rewrites
 * the whole film three times.
 *
 * **Which track gets which tag.** The new tracks are mapped last, so they are
 * the *last* subtitles of the output. Addressing `-metadata:s:s:0` instead
 * writes one track's language onto another — a silent corruption of the file,
 * found later by somebody wondering why their French subtitle says it is
 * English. The ordinal arithmetic is therefore tested directly rather than
 * trusted.
 */

import { describe, expect, it } from 'vitest'
import { buildSubtitleMuxCommand, buildSubtitleReadCommand } from '@shared/plex/command.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { mainAudio, mkv, subtitle, video } from './fixtures.js'

/** Every `-map` target in order. */
function maps(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (arg === '-map' ? [args[index + 1]] : []))
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

describe('reading tracks out to measure them', () => {
  it('reads the film once however many tracks are wanted', () => {
    const args = buildSubtitleReadCommand('/films/Heat/Heat.mkv', [
      { streamIndex: 2, outputPath: '/scratch/track-2.srt' },
      { streamIndex: 3, outputPath: '/scratch/track-3.srt' },
      { streamIndex: 4, outputPath: '/scratch/track-4.srt' }
    ])

    expect(args.filter((arg) => arg === '-i')).toHaveLength(1)
    expect(args[1]).toBe('/films/Heat/Heat.mkv')
    expect(maps(args)).toEqual(['0:2', '0:3', '0:4'])
  })

  it('writes the working files where it was told, not beside the film', () => {
    // These are scratch files. The folder the film is in may be read-only, on
    // somebody else's share, or watched by Plex — none of which is a place to
    // leave three .srt files mid-repair.
    const args = buildSubtitleReadCommand('/films/Heat/Heat.mkv', [
      { streamIndex: 2, outputPath: '/scratch/.plexfixer/track-2.srt' }
    ])
    expect(args.at(-1)).toBe('/scratch/.plexfixer/track-2.srt')
  })
})

describe('writing tracks back into the film', () => {
  it('rewrites several tracks in a single pass', () => {
    const args = buildSubtitleMuxCommand({
      mediaPath: '/films/Heat/Heat.mkv',
      outputPath: '/films/Heat/.Heat.working.mkv',
      container: 'mkv',
      subtitleCount: 3,
      tracks: [
        { subtitlePath: '/scratch/track-2.srt', replaceStreamIndex: 2, language: 'eng' },
        { subtitlePath: '/scratch/track-3.srt', replaceStreamIndex: 3, language: 'fre' },
        { subtitlePath: '/scratch/track-4.srt', replaceStreamIndex: 4, language: 'deu' }
      ]
    })

    // One output. Three runs would copy a 40 GB film three times to change
    // some timecodes.
    expect(args.filter((arg) => arg === '-i')).toHaveLength(4)
    expect(args.filter((arg) => arg.endsWith('.mkv'))).toHaveLength(2)
  })

  it('gives each new track its own tag and leaves the survivors alone', () => {
    const args = buildSubtitleMuxCommand({
      mediaPath: '/films/Heat/Heat.mkv',
      outputPath: '/films/Heat/.Heat.working.mkv',
      container: 'mkv',
      subtitleCount: 4,
      tracks: [
        { subtitlePath: '/scratch/a.srt', replaceStreamIndex: 3, language: 'fre' },
        { subtitlePath: '/scratch/b.srt', replaceStreamIndex: 4, language: 'deu' }
      ]
    })

    // Four subtitles, two replaced: two survive as ordinals 0 and 1, and the
    // incoming pair land at 2 and 3 in the order they were mapped.
    expect(valueAfter(args, '-metadata:s:s:2')).toBe('language=fre')
    expect(valueAfter(args, '-metadata:s:s:3')).toBe('language=deu')
    expect(args).not.toContain('-metadata:s:s:0')
    expect(args).not.toContain('-metadata:s:s:1')
  })

  it('copies everything but the subtitle it is replacing', () => {
    const args = buildSubtitleMuxCommand({
      mediaPath: '/films/Heat/Heat.mkv',
      outputPath: '/films/Heat/.Heat.working.mkv',
      container: 'mkv',
      subtitleCount: 1,
      tracks: [{ subtitlePath: '/scratch/a.srt', replaceStreamIndex: 2, language: 'eng' }]
    })

    expect(valueAfter(args, '-c')).toBe('copy')
    expect(args).not.toContain('-c:v')
    expect(args).not.toContain('-c:a')
  })
})

describe('the flags a replaced track keeps', () => {
  const base = {
    mediaPath: '/films/Heat/Heat.mkv',
    outputPath: '/films/Heat/.Heat.working.mkv',
    container: 'mkv' as const,
    subtitleCount: 2
  }

  it('writes both flags together, because one alone clears the other', () => {
    // `-disposition` sets the whole set. A resync of somebody's default
    // subtitle that wrote `forced` alone would leave them with a film whose
    // subtitle no longer comes up — a change nobody asked for, made by a
    // feature whose entire job is to change only the timing.
    const args = buildSubtitleMuxCommand({
      ...base,
      tracks: [{ subtitlePath: '/scratch/a.srt', replaceStreamIndex: 2, language: 'eng', default: true, forced: true }]
    })
    expect(valueAfter(args, '-disposition:s:1')).toBe('default+forced')
  })

  it('clears the flags explicitly when the track had none', () => {
    // Saying nothing would leave the muxer's own default instead, which is not
    // the same as "the track this is replacing had no flags".
    const args = buildSubtitleMuxCommand({
      ...base,
      tracks: [
        { subtitlePath: '/scratch/a.srt', replaceStreamIndex: 2, language: 'eng', default: false, forced: false }
      ]
    })
    expect(valueAfter(args, '-disposition:s:1')).toBe('0')
  })

  it('says nothing about flags for a track being added', () => {
    const args = buildSubtitleMuxCommand({
      ...base,
      tracks: [{ subtitlePath: '/scratch/a.srt', language: 'eng' }]
    })
    expect(args.some((arg) => arg.startsWith('-disposition'))).toBe(false)
  })
})

describe('what the plan says about retiming', () => {
  it('asks for nothing unless the setting or a rule asked', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'subrip', language: 'eng' })
    ])

    expect(analyzeFile(file, DEFAULT_SETTINGS).plan.resyncSubtitles).toEqual([])
    expect(
      analyzeFile(file, { ...DEFAULT_SETTINGS, resyncSubtitlesOnRepair: true }).plan.resyncSubtitles
    ).toEqual([2])
  })

  it('never asks to measure a picture subtitle', () => {
    // There are no cue times in a picture of text to compare against speech.
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', language: 'eng' }),
      subtitle({ index: 3, codec: 'subrip', language: 'fre' })
    ])

    const plan = analyzeFile(file, {
      ...DEFAULT_SETTINGS,
      targetContainer: 'mkv',
      remuxMkvToMp4: false,
      resyncSubtitlesOnRepair: true
    }).plan
    expect(plan.resyncSubtitles).toEqual([3])
  })
})
