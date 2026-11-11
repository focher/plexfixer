import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { buildFileReport, buildJobReport } from '@shared/report.js'
import type { Job } from '@shared/types.js'
import { mainAudio, mkv, mp4, video } from './fixtures.js'

const result = analyzeFile(
  mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'spa' })]),
  DEFAULT_SETTINGS
)

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    sourcePath: result.file.path,
    outputPath: '/out/Example.mp4',
    strategy: result.plan.strategy,
    mode: 'safe-remux',
    state: 'done',
    progress: { fraction: 1 },
    command: ['/usr/bin/ffmpeg', '-i', '/in/Example (2020).mkv', '-c', 'copy', '/out/Example.mp4'],
    startedAt: 1_000,
    finishedAt: 4_000,
    log: [
      { at: 1_000, level: 'info', text: 'Queued remux (stream copy)' },
      { at: 2_000, level: 'info', text: 'Running ffmpeg', detail: 'ffmpeg -i in.mkv out.mp4' },
      { at: 4_000, level: 'info', text: 'Done in 3.0s' }
    ],
    ...overrides
  }
}

describe('buildJobReport', () => {
  it('carries everything needed to diagnose a repair without the machine', () => {
    const text = buildJobReport({
      job: job(),
      result,
      environment: {
        ready: true,
        ffmpegPath: '/app/bin/ffmpeg',
        ffprobePath: '/app/bin/ffprobe',
        ffmpegSource: 'bundled',
        ffprobeSource: 'bundled',
        capabilities: {
          platform: 'linux',
          available: ['h264_nvenc', 'hevc_nvenc'],
          nvenc: true,
          qsv: false,
          amf: false,
          videotoolbox: false
        }
      },
      appVersion: '0.1.1',
      platform: 'macOS'
    })

    expect(text).toContain('0.1.1')
    expect(text).toContain('/app/bin/ffmpeg')
    expect(text).toContain('hw encode  nvenc')
    expect(text).toContain('h264_nvenc')
    // The source layout, so stream indexes in the command mean something.
    expect(text).toContain(result.file.path)
    expect(text).toContain('video')
    // Why it acted.
    for (const finding of result.findings) expect(text).toContain(finding.title)
    // What it ran, quoted so it can be pasted back into a shell.
    expect(text).toContain('"/in/Example (2020).mkv"')
    // What happened.
    expect(text).toContain('Queued remux (stream copy)')
    expect(text).toContain('Done in 3.0s')
    expect(text).toContain('ffmpeg -i in.mkv out.mp4')
  })

  it('times each step from the start of the job', () => {
    const text = buildJobReport({ job: job(), result })
    expect(text).toMatch(/0\.0s\s+Queued/)
    expect(text).toMatch(/1\.0s\s+Running ffmpeg/)
    expect(text).toMatch(/3\.0s\s+Done/)
  })

  it('marks failures so they stand out when skimming', () => {
    const text = buildJobReport({
      job: job({
        state: 'failed',
        message: 'ffmpeg exited with code 1',
        log: [
          { at: 1_000, level: 'info', text: 'Running ffmpeg' },
          { at: 2_000, level: 'error', text: 'ffmpeg exited with code 1', detail: 'Tag hvc1 incompatible' }
        ]
      }),
      result
    })

    expect(text).toContain('state      failed')
    expect(text).toContain('ERR  ffmpeg exited with code 1')
    expect(text).toContain('Tag hvc1 incompatible')
  })

  it('still produces a usable report when the analysis is gone', () => {
    const text = buildJobReport({ job: job() })
    expect(text).toContain('# PlexFixer repair report')
    expect(text).toContain('Done in 3.0s')
    expect(text).not.toContain('## Findings')
  })
})

describe('buildFileReport', () => {
  it('explains a file that passed, which is the hard case', () => {
    // A clean file tells you nothing on its own: whether it should have been
    // flagged depends on the settings, so the report has to carry them.
    const clean = analyzeFile(mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]), {
      ...DEFAULT_SETTINGS,
      allowHevc: true,
      maxH264Level: 41
    })
    expect(clean.verdict).toBe('ok')

    const text = buildFileReport({ result: clean, settings: { ...DEFAULT_SETTINGS, allowHevc: true } })

    expect(text).toContain('verdict    ok')
    // The tracks it looked at, so "nothing found" can be checked rather than trusted.
    expect(text).toContain('Streams:')
    expect(text).toContain('video')
    expect(text).toContain('audio')
    // And the settings behind the verdict.
    expect(text).toContain('HEVC compatible   true')
    expect(text).toContain('target container  mp4')
    expect(text).toContain('(none)')
  })

  it('lists the findings and the mode for a file that did not pass', () => {
    const text = buildFileReport({
      result,
      settings: DEFAULT_SETTINGS,
      mode: 'report',
      modeSource: 'set on /Media/Anime'
    })
    expect(text).toContain('mode       report (set on /Media/Anime)')
    expect(text).toContain('# PlexFixer file report')
    expect(result.findings.length).toBeGreaterThan(0)
    for (const finding of result.findings) expect(text).toContain(finding.title)
  })

  it('works with no settings or environment to hand', () => {
    expect(() => buildFileReport({ result })).not.toThrow()
  })
})
