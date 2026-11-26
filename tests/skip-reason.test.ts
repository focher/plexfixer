/**
 * What the queue says when it puts a file down untouched.
 *
 * "Already Plex-ready — nothing to change" was said to every file with no
 * plan, including the ones whose scan had just called them blocked. A Dolby
 * Vision profile 7 file came back from Force transcode claiming it was fine,
 * directly underneath the blocker saying it was not, which is the kind of
 * contradiction that makes somebody stop trusting the rest of the report.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '../src/shared/plex/analyze.js'
import { RepairRunner } from '@shared/plex/runner.js'
import { localHost } from './node-host.js'
import type { AnalysisResult, Job } from '../src/shared/types.js'
import { flags, mainAudio, mp4, subtitle, video } from './fixtures.js'

function skipMessage(result: AnalysisResult): string {
  const updates: Job[] = []
  const runner = new RepairRunner(
    { ffmpegPath: '/nonexistent/ffmpeg', ffprobePath: '/nonexistent/ffprobe' },
    1,
    (job) => updates.push(job),
    localHost()
  )
  const job = runner.enqueue({ result, settings: DEFAULT_SETTINGS, mode: 'force-transcode' })
  expect(job.state).toBe('skipped')
  return job.message ?? ''
}

const clean = analyzeFile(
  mp4([video({ language: 'eng' }), mainAudio({ index: 1, codec: 'aac', language: 'eng' })], { faststart: true }),
  DEFAULT_SETTINGS
)

/** The user's file: one blocker nothing fixes, and no plan because of it. */
const dolbyVision7 = analyzeFile(
  mp4(
    [
      video({
        codec: 'hevc',
        codecTag: 'hvc1',
        language: 'eng',
        width: 3840,
        height: 2160,
        bitDepth: 10,
        profile: 'Main 10',
        pixFmt: 'yuv420p10le',
        dolbyVisionProfile: 7,
        isHdr: true
      }),
      mainAudio({ index: 1, codec: 'aac', language: 'eng', channels: 6, channelLayout: '5.1' }),
      subtitle({ index: 2, codec: 'mov_text', language: 'eng', disposition: flags({ default: true }) })
    ],
    { faststart: true }
  ),
  DEFAULT_SETTINGS
)

describe('skipping a file with no plan', () => {
  it('still says "already Plex-ready" when that is true', () => {
    expect(clean.findings).toEqual([])
    expect(skipMessage(clean)).toBe('Already Plex-ready — nothing to change')
  })

  it('names the blocker instead of claiming the file is fine', () => {
    expect(dolbyVision7.plan.strategy).toBe('none')
    const message = skipMessage(dolbyVision7)
    expect(message).not.toMatch(/Plex-ready/)
    expect(message).toMatch(/No repair fixes this/)
    expect(message).toMatch(/Dolby Vision profile 7/)
  })
})

describe('the plan it was skipped with', () => {
  it('lists no action for a change a later repair withdrew', () => {
    // The subtitle default is unwanted, so a check asks for it to be cleared;
    // MP4 cannot express "no subtitle" so the repair withdraws itself. The
    // plan was still printing "Fix 1 default/forced flag" afterwards, promising
    // a repair on a file that was then skipped as having nothing to do.
    expect(dolbyVision7.plan.trackChanges).toEqual([])
    expect(dolbyVision7.plan.actions).toEqual([])
    expect(dolbyVision7.findings.some((finding) => finding.code === 'default-subtitle-unwanted')).toBe(true)
  })
})
