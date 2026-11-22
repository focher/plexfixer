/**
 * Repair scripts: reading a manifest, the stdin/stdout protocol, how a flag
 * bound to a script turns into a step of the plan — and, with ffmpeg and
 * python3 installed, the example subtitle scrub run end to end by the runner.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { registerCheckScript, setField, setParam } from '@shared/plex/catalog/edit.js'
import { catalogFor, resolveCatalog, DEFAULT_CATALOG } from '@shared/plex/catalog/resolve.js'
import { statusIdOf } from '@shared/plex/catalog/match.js'
import { parseManifest, scriptInfo, type ScriptInfo } from '@shared/plex/scripts/manifest.js'
import { activeChecks, findingsFrom, reportsCurrent, withCheckReports } from '@shared/plex/scripts/checks.js'
import { readScriptLine, splitLines } from '@shared/plex/scripts/protocol.js'
import { probeFile } from '@shared/plex/probe.js'
import { RepairRunner } from '@shared/plex/runner.js'
import type { AppSettings, Job, MediaFile } from '@shared/types.js'
import { mainAudio, mp4, subtitle, video } from './fixtures.js'
import { localHost, nodeProcess } from './node-host.js'

const EXAMPLE = resolve('examples/repairs/subtitle-scrub')
const exampleManifest = readFileSync(join(EXAMPLE, 'plugin.json'), 'utf8')
const exampleRule = readFileSync(join(EXAMPLE, 'rule.txt'), 'utf8')

describe('parseManifest', () => {
  it('reads the example script', () => {
    const { manifest, problems } = parseManifest(exampleManifest, 'subtitle-scrub')
    expect(problems).toEqual([])
    expect(manifest?.name).toBe('Subtitle scrub')
    expect(manifest?.params.patterns?.type).toBe('list')
    expect(manifest?.defaults.codecs).toEqual(['subrip', 'mov_text'])
  })

  it('refuses a manifest for another folder, without a command, or with a bad default', () => {
    const base = { protocol: 1, id: 'x', name: 'X', command: ['run'] }
    expect(parseManifest(JSON.stringify(base), 'y').problems).toContain('"id" must be "y", the name of its folder')
    expect(parseManifest(JSON.stringify({ ...base, command: [] }), 'x').problems[0]).toContain('"command"')
    expect(
      parseManifest(JSON.stringify({ ...base, params: { n: { type: 'number', label: 'N', default: 'three' } } }), 'x').problems
    ).toEqual(['params.n: needs a "default" that fits its type'])
    expect(parseManifest('{', 'x').problems[0]).toContain('not JSON')
  })

  it('works out whether a listing may run', () => {
    const listing = { id: 'subtitle-scrub', dir: EXAMPLE, manifest: exampleManifest, hash: 'abc', files: [] }
    expect(scriptInfo(listing).trust).toBe('unapproved')
    expect(scriptInfo({ ...listing, trustedHash: 'abc' }).trust).toBe('approved')
    expect(scriptInfo({ ...listing, trustedHash: 'old' }).trust).toBe('changed')
    expect(scriptInfo({ ...listing, manifest: undefined }).trust).toBe('broken')
  })
})

describe('the script protocol', () => {
  it('reads progress, logs and the result, and keeps anything else as text', () => {
    expect(readScriptLine('{"type":"progress","fraction":1.7}')).toEqual({ type: 'progress', fraction: 1 })
    expect(readScriptLine('{"type":"log","level":"warn","text":"hm"}')).toEqual({ type: 'log', level: 'warn', text: 'hm' })
    expect(readScriptLine('{"type":"result","message":"ok"}')).toEqual({ type: 'result', message: 'ok' })
    expect(readScriptLine('hello')).toEqual({ type: 'log', level: 'info', text: 'hello' })
    expect(readScriptLine('   ')).toBeUndefined()
  })

  it('puts lines cut across chunks back together', () => {
    const first = splitLines('', '{"type":"pro')
    expect(first).toEqual({ lines: [], rest: '{"type":"pro' })
    expect(splitLines(first.rest, 'gress","fraction":0.5}\nnext')).toEqual({
      lines: ['{"type":"progress","fraction":0.5}'],
      rest: 'next'
    })
  })
})

/* ------------------------------------------------------------------ *
 * Binding a flag to a script
 * ------------------------------------------------------------------ */

const RULE_ID = 'user.unscrubbed-subtitles'
const withScrub = (patch: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
  userModules: [{ id: RULE_ID, script: exampleRule }],
  catalog: setField({}, 'flags', RULE_ID, 'repair', 'script.subtitle-scrub')
})
const subtitled = mp4([
  video({ language: 'eng' }),
  mainAudio({ index: 1, language: 'eng' }),
  subtitle({ index: 2, codec: 'mov_text', language: 'eng' })
])

describe('a flag bound to a script', () => {
  it('can only be a script id, besides its own repair or none', () => {
    const { problems } = resolveCatalog(DEFAULT_CATALOG, {
      flags: { 'mp4-not-faststart': { repair: 'script.subtitle-scrub' }, 'video-missing': { repair: 'script.Bad Id' } }
    })
    expect(problems).toEqual(['flags.video-missing.repair: not a valid value; ignored'])
  })

  it('adds a step to the plan, and makes the file fixable rather than blocked', () => {
    const settings = withScrub()
    const result = analyzeFile(subtitled, settings)
    expect(result.findings.map((f) => f.code)).toContain(RULE_ID)
    expect(result.plan.scriptSteps).toEqual([{ script: 'subtitle-scrub', params: {}, flags: [RULE_ID] }])
    expect(result.plan.strategy).toBe('remux')
    expect(result.plan.unresolved.map((f) => f.code)).not.toContain(RULE_ID)
    expect(statusIdOf(result, catalogFor(settings))).toBe('fixable')
  })

  it('takes the flag from its built-in repair', () => {
    const slow = mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: false })
    const settings = { ...DEFAULT_SETTINGS, catalog: setField({}, 'flags', 'mp4-not-faststart', 'repair', 'script.my-index') }
    const result = analyzeFile(slow, settings)
    expect(result.plan.scriptSteps?.[0]?.script).toBe('my-index')
    expect(result.plan.actions.map((a) => a.label).join('\n')).not.toContain('move the index')
  })

  it('runs nothing for a script switched off, and leaves its flag unresolved', () => {
    const base = withScrub()
    const settings = { ...base, catalog: setField(base.catalog, 'repairs', 'script.subtitle-scrub', 'enabled', false) }
    const result = analyzeFile(subtitled, settings)
    expect(result.plan.scriptSteps).toBeUndefined()
    expect(result.plan.unresolved.map((f) => f.code)).toContain(RULE_ID)
  })

  it('stops matching once the file carries the tag the script writes', () => {
    const done = { ...subtitled, tags: { PLEXFIXER_SCRUBBED: '1.0.0' } }
    expect(analyzeFile(done, withScrub()).findings.map((f) => f.code)).not.toContain(RULE_ID)
  })
})

/* ------------------------------------------------------------------ *
 * The example, end to end
 * ------------------------------------------------------------------ */

const execFileAsync = promisify(execFile)
const find = (binary: string): string | undefined =>
  [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
    .filter((dir) => dir && existsSync(join(dir, binary)))
    .map((dir) => join(dir, binary))[0]
const FFMPEG = find('ffmpeg')
const FFPROBE = find('ffprobe')
const PYTHON = find('python3')

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plexfixer-scripts-'))
})
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

/** The local host, able to start the example scripts the way the native side would. */
const scriptHost = () => ({
  ...localHost(),
  startScript: (kind: 'checks' | 'repairs', id: string, input: string) => {
    const folder = resolve('examples', kind, id)
    const manifest = JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')) as { id: string; command: string[] }
    if (manifest.id !== id) throw new Error(`no script ${id}`)
    const [program, ...rest] = manifest.command.map((part) => part.replace('{pluginDir}', folder))
    const child = spawn(program === 'python3' ? PYTHON! : program!, rest, { cwd: folder })
    child.stdin.end(input)
    return nodeProcess(child)
  }
})

const approved: ScriptInfo = {
  ...scriptInfo({ id: 'subtitle-scrub', dir: EXAMPLE, manifest: exampleManifest, hash: 'h', trustedHash: 'h', files: [] })
}

async function movieWithAdverts(): Promise<string> {
  const srt = join(dir, 'subs.srt')
  await writeFile(
    srt,
    '1\n00:00:00,100 --> 00:00:00,900\nSubtitles by SomeGroup\n\n' +
      '2\n00:00:01,000 --> 00:00:01,800\nHello there.\n\n' +
      '3\n00:00:02,000 --> 00:00:02,800\nwww.example-adverts.com\n'
  )
  const path = join(dir, 'Movie (2001).mp4')
  await execFileAsync(FFMPEG!, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-i', srt,
    '-map', '0', '-map', '1', '-map', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'mov_text',
    '-metadata:s:v:0', 'language=eng', '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=eng',
    '-disposition:a:0', 'default', '-movflags', '+faststart',
    '-y', path
  ])
  return path
}

describe.runIf(Boolean(FFMPEG && FFPROBE && PYTHON))('the subtitle scrub, through the runner', () => {
  it('removes the advert cues, tags the file, and the re-check finds nothing left', { timeout: 60_000 }, async () => {
    const path = await movieWithAdverts()
    const settings = withScrub()
    const host = scriptHost()
    const result = analyzeFile(await probeFile(path, { ffprobePath: FFPROBE!, host }), settings)
    expect(result.plan.scriptSteps?.length).toBe(1)

    let finished: Job | undefined
    const runner = new RepairRunner({ ffmpegPath: FFMPEG!, ffprobePath: FFPROBE! }, 1, (job) => {
      if (job.state === 'done' || job.state === 'failed' || job.state === 'skipped') finished = job
    }, host)
    runner.enqueue({ result, settings, mode: 'safe-remux', scripts: [approved] })
    for (let waited = 0; !finished && waited < 45_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const log = finished?.log.map((entry) => `${entry.text}\n${entry.detail ?? ''}`).join('\n')
    expect(finished?.state, log).toBe('done')
    expect(log).toContain('removed 2 cue(s)')
    expect(finished?.remaining).toEqual([])

    const { stdout } = await execFileAsync(FFMPEG!, ['-v', 'error', '-i', finished!.outputPath, '-map', '0:s:0', '-f', 'srt', '-'])
    expect(stdout).toContain('Hello there.')
    expect(stdout).not.toMatch(/Subtitles by|www\./)
    expect(stdout.trim().startsWith('1\n')).toBe(true)

    const after = await probeFile(finished!.outputPath, { ffprobePath: FFPROBE!, host })
    expect(Object.keys(after.tags).map((tag) => tag.toLowerCase())).toContain('plexfixer_scrubbed')
    expect(analyzeFile(after, settings).findings.map((f) => f.code)).not.toContain(RULE_ID)
  })

  it('fails the job, leaving the original alone, when the script is not approved', { timeout: 30_000 }, async () => {
    const path = await movieWithAdverts()
    const settings = withScrub()
    const host = scriptHost()
    const result = analyzeFile(await probeFile(path, { ffprobePath: FFPROBE!, host }), settings)
    let finished: Job | undefined
    const runner = new RepairRunner({ ffmpegPath: FFMPEG!, ffprobePath: FFPROBE! }, 1, (job) => {
      if (job.state === 'done' || job.state === 'failed') finished = job
    }, host)
    runner.enqueue({ result, settings, mode: 'safe-remux', scripts: [{ ...approved, trust: 'unapproved' }] })
    for (let waited = 0; !finished && waited < 25_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(finished?.state).toBe('failed')
    expect(finished?.message).toContain('has not been approved')
    expect(existsSync(path)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Check scripts
 * ------------------------------------------------------------------ */

const ADS = resolve('examples/checks/subtitle-ads')
const adsManifest = readFileSync(join(ADS, 'plugin.json'), 'utf8')
const adsScript: ScriptInfo = scriptInfo(
  { id: 'subtitle-ads', dir: ADS, manifest: adsManifest, hash: 'a', trustedHash: 'a', files: [] },
  'checks'
)
const ADVERTS = 'ext.subtitle-ads.adverts'
const adsApproved = (patch: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
  catalog: registerCheckScript(patch.catalog ?? {}, 'ext.subtitle-ads', [
    { id: ADVERTS, label: 'Subtitle adverts', hint: '', category: 'subtitle' }
  ])
})

describe('a check script', () => {
  it('declares the flags it raises in its manifest', () => {
    expect(adsScript.problems).toEqual([])
    expect(adsScript.repairId).toBe('ext.subtitle-ads')
    expect(adsScript.manifest?.raises.map((flag) => flag.code)).toEqual(['adverts'])
    const { problems } = parseManifest(JSON.stringify({ protocol: 1, id: 'x', name: 'X', command: ['run'] }), 'x', 'checks')
    expect(problems[0]).toContain('"raises"')
  })

  it('may only report the codes it declared, scoped by its name', () => {
    const { findings, problems } = findingsFrom(adsScript.manifest!, [
      { code: 'adverts', title: 'Ads', streamIndexes: [2] },
      { code: 'drm-protected', title: 'Sneaky' }
    ])
    expect(findings.map((f) => f.code)).toEqual([ADVERTS])
    expect(findings[0]?.severity).toBe('warning')
    expect(problems[0]).toContain('not one of the codes')
  })

  it('runs only once approved and switched on in the catalog', () => {
    expect(activeChecks([adsScript], DEFAULT_SETTINGS)).toEqual([])
    expect(activeChecks([{ ...adsScript, trust: 'unapproved' }], adsApproved())).toEqual([])
    expect(activeChecks([adsScript], adsApproved()).map((check) => check.id)).toEqual(['subtitle-ads'])
  })

  it('is due again when its files or settings change', () => {
    const [check] = activeChecks([adsScript], adsApproved())
    const reports = { 'subtitle-ads': { fingerprint: check!.fingerprint } }
    expect(reportsCurrent(reports, [check!])).toBe(true)
    const tuned = adsApproved({ catalog: setParam({}, 'checks', 'ext.subtitle-ads', 'codecs', ['subrip']) })
    expect(reportsCurrent(reports, activeChecks([adsScript], tuned))).toBe(false)
    expect(reportsCurrent(reports, activeChecks([{ ...adsScript, hash: 'b' }], adsApproved()))).toBe(false)
  })

  it('has its stored answer read back by analysis, while it is switched on', () => {
    const reported: MediaFile = {
      ...subtitled,
      checkReports: {
        'subtitle-ads': {
          fingerprint: 'x',
          findings: [{ code: ADVERTS, severity: 'warning' as const, remedy: 'manual' as const, title: 'Ads', detail: '' }]
        }
      }
    }
    expect(analyzeFile(reported, adsApproved()).findings.map((f) => f.code)).toContain(ADVERTS)
    const off = adsApproved()
    const switchedOff = { ...off, catalog: setField(off.catalog, 'checks', 'ext.subtitle-ads', 'enabled', false) }
    expect(analyzeFile(reported, switchedOff).findings.map((f) => f.code)).not.toContain(ADVERTS)
  })

  it('says so when it could not check the file, rather than the file looking clean', () => {
    const failed = { ...subtitled, checkReports: { 'subtitle-ads': { fingerprint: 'x', findings: [], error: 'boom' } } }
    const note = analyzeFile(failed, adsApproved()).findings.find((f) => f.code === 'ext.subtitle-ads.failed')
    expect(note?.severity).toBe('info')
    expect(note?.detail).toBe('boom')
  })
})

describe.runIf(Boolean(FFMPEG && FFPROBE && PYTHON))('the subtitle-ads check and the scrub, together', () => {
  it('finds the adverts, the scrub removes them, and the re-check finds none', { timeout: 90_000 }, async () => {
    const path = await movieWithAdverts()
    const host = scriptHost()
    const base = adsApproved()
    const settings = { ...base, catalog: setField(base.catalog, 'flags', ADVERTS, 'repair', 'script.subtitle-scrub') }
    const active = activeChecks([adsScript], settings)
    const checks = { active, host, ffmpegPath: FFMPEG!, ffprobePath: FFPROBE!, settings, signal: new AbortController().signal }

    const file = await withCheckReports(await probeFile(path, { ffprobePath: FFPROBE!, host }), checks)
    expect(file.checkReports?.['subtitle-ads']?.error).toBeUndefined()
    const result = analyzeFile(file, settings)
    const advert = result.findings.find((f) => f.code === ADVERTS)
    expect(advert?.title).toContain('2 advert lines')
    expect(result.plan.scriptSteps?.[0]?.script).toBe('subtitle-scrub')

    let finished: Job | undefined
    const runner = new RepairRunner({ ffmpegPath: FFMPEG!, ffprobePath: FFPROBE! }, 1, (job) => {
      if (job.state === 'done' || job.state === 'failed' || job.state === 'skipped') finished = job
    }, host)
    runner.enqueue({ result, settings, mode: 'safe-remux', scripts: [adsScript, approved] })
    for (let waited = 0; !finished && waited < 60_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const log = finished?.log.map((entry) => `${entry.text}\n${entry.detail ?? ''}`).join('\n')
    expect(finished?.state, log).toBe('done')
    expect(finished?.remaining).toEqual([])
    expect(finished?.rechecked?.checkReports?.['subtitle-ads']?.findings).toEqual([])
  })
})
