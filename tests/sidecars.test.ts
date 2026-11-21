/**
 * Writing subtitle sidecars.
 *
 * Two things are being guarded. One is cost: ffmpeg reads an input once and
 * can demux it to as many outputs as it is given, so every sidecar should come
 * out of a single pass over the film rather than a pass each. Three tracks on
 * a 4.6 GB film was fourteen gigabytes of reading for a few hundred kilobytes
 * of text.
 *
 * The other is which file is read. After an in-place repair the original has
 * been moved into the backup folder and the repaired file has taken its place
 * — and the repaired file is usually missing the very tracks being extracted,
 * because needing to be dropped is *why* they are being extracted.
 */

import { describe, expect, it } from 'vitest'
import {
  buildSubtitleExtractCommand,
  buildSubtitleExtractCommands,
  sidecarTargets
} from '@shared/plex/command.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { mainAudio, mkv, subtitle, video } from './fixtures.js'
import type { AnalysisResult } from '@shared/types.js'

/**
 * An MKV with three styled subtitle tracks.
 *
 * Styled tracks are extracted whatever the container: clients cannot reproduce
 * their fonts and positioning, so Plex burns them into the picture instead. A
 * SubRip track would not be here — MP4 takes those happily, converted.
 */
function withSubtitles(): AnalysisResult {
  const file = mkv(
    [
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'ass', language: 'eng' }),
      subtitle({ index: 3, codec: 'ass', language: 'fre' }),
      subtitle({ index: 4, codec: 'ass', language: 'eng', disposition: { ...subtitle().disposition, forced: true } })
    ],
    { path: '/films/Heat/Heat.mkv', fileName: 'Heat.mkv' }
  )
  return analyzeFile(file, DEFAULT_SETTINGS)
}

describe('where the sidecars go', () => {
  it('names them the way Plex matches them', () => {
    const targets = sidecarTargets(withSubtitles(), '/films/Heat/Heat')
    expect(targets.map((target) => target.outputPath)).toEqual([
      '/films/Heat/Heat.eng.srt',
      '/films/Heat/Heat.fre.srt',
      '/films/Heat/Heat.eng.forced.srt'
    ])
  })

  it('keeps two tracks in one language apart', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'ass', language: 'eng' }),
      subtitle({ index: 3, codec: 'ass', language: 'eng' })
    ])
    const targets = sidecarTargets(analyzeFile(file, DEFAULT_SETTINGS), '/x/Film')
    expect(targets.map((t) => t.outputPath)).toEqual(['/x/Film.eng.srt', '/x/Film.eng.2.srt'])
  })
})

describe('one pass for every sidecar', () => {
  it('reads the film once and writes them all', () => {
    const targets = sidecarTargets(withSubtitles(), '/films/Heat/Heat')
    const args = buildSubtitleExtractCommand('/backups/Heat.mkv', targets)

    // One input, named once.
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1)
    expect(args[1]).toBe('/backups/Heat.mkv')

    // And one output per track, each from its own stream.
    expect(args.filter((arg) => arg === '-map')).toHaveLength(3)
    expect(args).toEqual([
      '-i', '/backups/Heat.mkv',
      '-map', '0:2', '-c:s', 'srt', '-y', '/films/Heat/Heat.eng.srt',
      '-map', '0:3', '-c:s', 'srt', '-y', '/films/Heat/Heat.fre.srt',
      '-map', '0:4', '-c:s', 'srt', '-y', '/films/Heat/Heat.eng.forced.srt'
    ])
  })

  it('writes only the tracks it is given, so an existing sidecar is left alone', () => {
    const targets = sidecarTargets(withSubtitles(), '/films/Heat/Heat')
    const args = buildSubtitleExtractCommand('/backups/Heat.mkv', [targets[1]])
    expect(args.filter((arg) => arg === '-map')).toHaveLength(1)
    expect(args).toContain('/films/Heat/Heat.fre.srt')
  })

  it('is one run where there used to be one per track', () => {
    const result = withSubtitles()
    const separate = buildSubtitleExtractCommands(result, '/films/Heat/Heat')
    expect(separate).toHaveLength(3)
    // Each of those reads the whole film; the combined form reads it once.
    expect(separate.every((command) => command.args[0] === '-i')).toBe(true)
  })
})

describe('which file the sidecars are cut from', () => {
  it('reads whatever it is told to, not the path the film came from', () => {
    // The repaired file has taken the original's path by now, and the tracks
    // being extracted are the ones it no longer has.
    const result = withSubtitles()
    const separate = buildSubtitleExtractCommands(result, '/films/Heat/Heat', '/films/Heat/.plexfixer-backups/Heat.mkv')
    for (const command of separate) {
      expect(command.args[1]).toBe('/films/Heat/.plexfixer-backups/Heat.mkv')
    }
  })

  it('still falls back to the film’s own path when nothing else is given', () => {
    const separate = buildSubtitleExtractCommands(withSubtitles(), '/films/Heat/Heat')
    expect(separate[0].args[1]).toBe('/films/Heat/Heat.mkv')
  })

  it('agrees with the single-run form about what goes where', () => {
    const result = withSubtitles()
    const targets = sidecarTargets(result, '/films/Heat/Heat')
    const separate = buildSubtitleExtractCommands(result, '/films/Heat/Heat', '/src.mkv')
    const together = buildSubtitleExtractCommand('/src.mkv', targets)
    // Everything the per-track form would write appears in the one-pass form.
    for (const command of separate) {
      expect(together).toContain(command.outputPath)
      expect(together.join(' ')).toContain(command.args.slice(2).join(' '))
    }
  })
})
