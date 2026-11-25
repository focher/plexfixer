/**
 * Rules the user writes themselves.
 *
 * Three things have to hold. A script that says something sensible has to do
 * what it says; a script that says something wrong has to be refused with the
 * line it went wrong on, rather than quietly matching nothing; and a rule, once
 * read, has to be a module like any other — switchable, explainable, and unable
 * to reach anything the built-in modules cannot.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { parseScript } from '@shared/plex/modules/script/parse.js'
import { describeScript } from '@shared/plex/modules/script/describe.js'
import { newUserModuleId, readUserModule } from '@shared/plex/modules/script/module.js'
import type { AppSettings } from '@shared/types.js'
import { audio, flags, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

const withRules = (...scripts: string[]): AppSettings => ({
  ...DEFAULT_SETTINGS,
  userModules: scripts.map((script, index) => ({ id: `user.rule-${index}`, script }))
})

/* ------------------------------------------------------------------ *
 * Reading a script
 * ------------------------------------------------------------------ */

describe('reading a script', () => {
  it('reads the simplest rule that does anything', () => {
    const { script, problems } = parseScript(`
      name Flag DivX
      when video.codec in divx, dx50, xvid
      report blocker "DivX video" "No client decodes it."
    `)
    expect(problems).toEqual([])
    expect(script?.name).toBe('Flag DivX')
    expect(script?.conditions).toHaveLength(1)
    expect(script?.conditions[0].values).toEqual(['divx', 'dx50', 'xvid'])
    expect(script?.report).toEqual({
      severity: 'blocker',
      title: 'DivX video',
      detail: 'No client decodes it.'
    })
  })

  it('ignores blank lines and comments', () => {
    const { script, problems } = parseScript(`
# a rule about DivX
name Flag DivX

# the condition
when video.codec is divx
fix transcode-video
    `)
    expect(problems).toEqual([])
    expect(script?.fixes).toEqual(['transcode-video'])
  })

  it('folds an indented line into the one above it', () => {
    const { script, problems } = parseScript(
      'name Long one\n' +
        'when video.codec is divx\n' +
        'report warning "DivX"\n' +
        '  "A long explanation that carries on\n' +
        '   over several lines."\n'
    )
    expect(problems).toEqual([])
    expect(script?.report?.detail).toBe('A long explanation that carries on over several lines.')
  })

  it('lets a quote appear inside a quoted value', () => {
    const { script } = parseScript('name X\nwhen video.codec is divx\nreport info "A \\"quoted\\" word"')
    expect(script?.report?.title).toBe('A "quoted" word')
  })

  it('takes several conditions, all of which have to hold', () => {
    const { script, problems } = parseScript(`
      name Both
      when container is matroska
      when audio.channels above 6
      fix remux
    `)
    expect(problems).toEqual([])
    expect(script?.conditions).toHaveLength(2)
  })
})

describe('refusing a script', () => {
  const problemsOf = (source: string): string[] => parseScript(source).problems.map((p) => p.message)
  const linesOf = (source: string): number[] => parseScript(source).problems.map((p) => p.line)

  it('wants a name', () => {
    expect(problemsOf('when video.codec is divx\nreport info "x"')).toContain(
      'A rule needs a name: start a line with "name".'
    )
  })

  it('wants at least one condition, so a rule cannot match the whole library', () => {
    expect(problemsOf('name X\nreport info "x"').join(' ')).toContain('at least one "when" line')
  })

  it('wants the rule to do something', () => {
    expect(problemsOf('name X\nwhen video.codec is divx').join(' ')).toContain('has to do something')
  })

  it('points at the line a mistake is on', () => {
    expect(linesOf('name X\nwhen video.codec is divx\nwhen nonsense.field is 3\nreport info "x"')).toEqual([3])
  })

  it('names what cannot be asked about', () => {
    expect(problemsOf('name X\nwhen video.nonsense is 3\nreport info "x"')).toContain(
      'There is nothing called "video.nonsense" to ask about'
    )
  })

  it('refuses a comparison that does not fit the value', () => {
    expect(problemsOf('name X\nwhen video.codec above 3\nreport info "x"').join(' ')).toContain(
      'cannot be used on video.codec'
    )
  })

  it('refuses a number that is not one', () => {
    expect(problemsOf('name X\nwhen audio.channels above six\nreport info "x"')).toContain('"six" is not a number')
  })

  it('refuses a true/false question answered with something else', () => {
    expect(problemsOf('name X\nwhen video.interlaced is yes\nreport info "x"')).toContain(
      '"yes" is not true or false'
    )
  })

  it('catches a quote left open', () => {
    expect(problemsOf('name X\nwhen video.codec is divx\nreport info "never closed')).toContain(
      'A quote was opened and never closed'
    )
  })

  it('refuses a line that is not a directive at all', () => {
    expect(problemsOf('name X\nwhen video.codec is divx\nprint "hello"\nreport info "x"').join(' ')).toContain(
      'is not something a rule can say'
    )
  })

  it('refuses a fix that does not exist', () => {
    expect(problemsOf('name X\nwhen video.codec is divx\nfix delete-file').join(' ')).toContain(
      'There is no fix called "delete-file"'
    )
  })

  it('refuses dropping tracks when the rule matched none', () => {
    // `drop-track` acts on what was matched; a rule matching only the
    // container has matched no track to act on.
    expect(problemsOf('name X\nwhen container is matroska\nfix drop-track').join(' ')).toContain(
      'needs a "when" line about audio or subtitle tracks'
    )
  })

  it('allows dropping tracks when the rule matched some', () => {
    expect(parseScript('name X\nwhen audio.codec is truehd\nfix drop-track').problems).toEqual([])
  })

  it('refuses two reports in one rule', () => {
    expect(
      problemsOf('name X\nwhen video.codec is divx\nreport info "a"\nreport info "b"').join(' ')
    ).toContain('already a "report" line above')
  })
})

/* ------------------------------------------------------------------ *
 * Saying it back
 * ------------------------------------------------------------------ */

describe('saying a rule back in English', () => {
  it('describes a rule that wrote no prose of its own', () => {
    const { script } = parseScript('name X\nwhen video.codec in divx, xvid\nreport warning "DivX"\nfix transcode-video')
    const prose = describeScript(script!)
    expect(prose.howItWorks).toBe("It matches a file when the video's codec is divx or xvid.")
    expect(prose.whatItDoes).toContain('reports a warning, “DivX”')
    expect(prose.whatItDoes).toContain('re-encode the video')
    expect(prose.summary).toBe('DivX')
  })

  it('joins several conditions', () => {
    const { script } = parseScript(
      'name X\nwhen container is matroska\nwhen audio.channels above 6\nreport info "y"'
    )
    expect(describeScript(script!).howItWorks).toBe(
      "It matches a file when the container is matroska, and an audio track's channels is more than 6."
    )
  })

  it('prefers the author’s own words when they wrote some', () => {
    const { script } = parseScript(
      'name X\nhow Because I say so.\nwhen video.codec is divx\nreport info "y"'
    )
    expect(describeScript(script!).howItWorks).toBe('Because I say so.')
  })
})

/* ------------------------------------------------------------------ *
 * Running one
 * ------------------------------------------------------------------ */

const divxRule = `
name Flag DivX
when video.codec in divx, dx50, xvid
report blocker "DivX video" "No mainstream client decodes DivX."
fix transcode-video
`

describe('running a rule the user wrote', () => {
  it('reports on a file it matches, and not on one it does not', () => {
    const divx = mkv([video({ codec: 'divx', language: 'eng' }), mainAudio({ index: 1, language: 'eng' })])
    const ordinary = mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })])
    const settings = withRules(divxRule)

    const hit = analyzeFile(divx, settings).findings.find((f) => f.title === 'DivX video')
    expect(hit?.severity).toBe('blocker')
    expect(hit?.code).toBe('custom')
    expect(hit?.detail).toBe('No mainstream client decodes DivX.')
    expect(hit?.streamIndexes).toEqual([0])

    expect(analyzeFile(ordinary, settings).findings.some((f) => f.title === 'DivX video')).toBe(false)
  })

  it('asks for the re-encode it said it wanted', () => {
    const divx = mkv([video({ codec: 'divx', language: 'eng' }), mainAudio({ index: 1, language: 'eng' })])
    const result = analyzeFile(divx, withRules(divxRule))
    expect(result.plan.strategy).toBe('transcode-video')
    expect(result.plan.videoTranscode).toBeDefined()
  })

  it('can be switched off like anything else', () => {
    const divx = mkv([video({ codec: 'divx', language: 'eng' }), mainAudio({ index: 1, language: 'eng' })])
    const settings = { ...withRules(divxRule), disabledModules: ['user.rule-0'] }
    expect(analyzeFile(divx, settings).findings.some((f) => f.title === 'DivX video')).toBe(false)
  })

  it('is left out, rather than stopping the scan, when it will not parse', () => {
    const file = mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })])
    const settings = withRules('name Broken\nwhen nonsense is 3\nreport info "x"')
    // The scan still produces its usual answer about the file itself.
    expect(() => analyzeFile(file, settings)).not.toThrow()
    expect(analyzeFile(file, settings).findings.some((f) => f.code === 'custom')).toBe(false)
  })

  it('never matches a question the file does not answer', () => {
    // The file says nothing about its profile. "is not high" is *not* true of
    // silence — a rule must not fire on an absence it never asked about.
    const quiet = mkv([video({ language: 'eng', profile: undefined }), mainAudio({ index: 1, language: 'eng' })])
    const rule = 'name Odd profile\nwhen video.profile is not high\nreport info "Odd profile"'
    expect(analyzeFile(quiet, withRules(rule)).findings.some((f) => f.title === 'Odd profile')).toBe(false)

    // And it does fire on a file that answers the question differently.
    const stated = mkv([
      video({ language: 'eng', profile: 'Main' }),
      mainAudio({ index: 1, language: 'eng' })
    ])
    expect(analyzeFile(stated, withRules(rule)).findings.some((f) => f.title === 'Odd profile')).toBe(true)
  })

  it('asks about silence with "is missing"', () => {
    const quiet = mkv([video({ language: 'eng', profile: undefined }), mainAudio({ index: 1, language: 'eng' })])
    const stated = mkv([video({ language: 'eng', profile: 'High' }), mainAudio({ index: 1, language: 'eng' })])
    const missing = 'name Untagged\nwhen video.profile is missing\nreport info "No profile"'
    const set = 'name Tagged\nwhen video.profile is set\nreport info "Has a profile"'

    expect(analyzeFile(quiet, withRules(missing)).findings.some((f) => f.title === 'No profile')).toBe(true)
    expect(analyzeFile(stated, withRules(missing)).findings.some((f) => f.title === 'No profile')).toBe(false)
    expect(analyzeFile(stated, withRules(set)).findings.some((f) => f.title === 'Has a profile')).toBe(true)
    expect(analyzeFile(quiet, withRules(set)).findings.some((f) => f.title === 'Has a profile')).toBe(false)
  })

  it('points the finding at the tracks it matched', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, codec: 'truehd', language: 'eng' }),
      audio({ index: 2, codec: 'truehd', language: 'fre' }),
      audio({ index: 3, codec: 'aac', language: 'eng' })
    ])
    const rule = 'name Lossless\nwhen audio.codec is truehd\nreport info "TrueHD here"'
    const hit = analyzeFile(file, withRules(rule)).findings.find((f) => f.title === 'TrueHD here')
    expect(hit?.streamIndexes).toEqual([1, 2])
  })

  it('drops the tracks it matched, and credits the rule for it', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, codec: 'aac', language: 'eng' }),
      audio({ index: 2, codec: 'aac', language: 'fre', title: 'Director commentary' })
    ])
    const rule = 'name No commentary\nwhen audio.title contains commentary\nfix drop-track'
    const plan = analyzeFile(file, withRules(rule)).plan
    const dropped = plan.trackChanges.filter((change) => change.drop)
    expect(dropped).toHaveLength(1)
    expect(dropped[0].streamIndex).toBe(2)
    expect(dropped[0].reason).toContain('No commentary')
  })

  it('measures a subtitle track it asked for, whatever the setting says', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'subrip', language: 'eng' })
    ])
    const rule = 'name Time the subs\nwhen subtitle.codec is subrip\nfix resync-subtitles'
    const settings = { ...withRules(rule), resyncSubtitlesOnRepair: false }
    const plan = analyzeFile(file, settings).plan
    expect(plan.resyncSubtitles).toEqual([2])
  })

  it('rewrites a file it asks to have rewritten, and says who asked', () => {
    const file = mp4([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng', disposition: flags({ default: true }) })
    ])
    const clean = analyzeFile(file, DEFAULT_SETTINGS)
    expect(clean.plan.strategy).toBe('none')

    const rule = 'name Normalise everything\nwhen container is mp4\nfix remux'
    const plan = analyzeFile(file, withRules(rule)).plan
    expect(plan.strategy).toBe('remux')
    expect(plan.actions.some((action) => action.label.includes('Normalise everything'))).toBe(true)
  })

  it('does not drop a track twice when a built-in check is already dropping it', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'ass', language: 'eng' })
    ])
    // ASS cannot live in an MP4, so the built-in check already drops it.
    const rule = 'name Also drop it\nwhen subtitle.codec is ass\nfix drop-track'
    const plan = analyzeFile(file, withRules(rule)).plan
    expect(plan.trackChanges.filter((change) => change.drop && change.streamIndex === 2)).toHaveLength(1)
  })

  it('leaves the fixes undone when the repair that carries them out is off', () => {
    const file = mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, codec: 'aac', language: 'eng' }),
      audio({ index: 2, codec: 'aac', language: 'fre', title: 'Director commentary' })
    ])
    const rule = 'name No commentary\nwhen audio.title contains commentary\nreport info "Commentary"\nfix drop-track'
    const settings = { ...withRules(rule), disabledModules: ['repair.custom-requests'] }
    const result = analyzeFile(file, settings)
    // Still reported …
    expect(result.findings.some((f) => f.title === 'Commentary')).toBe(true)
    // … but not acted on, and said to be unresolved.
    expect(result.plan.trackChanges.some((change) => change.drop)).toBe(false)
    expect(result.plan.unresolved.some((f) => f.title === 'Commentary')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Keeping them
 * ------------------------------------------------------------------ */

describe('a rule as Settings sees it', () => {
  it('reads a name out of a script too broken to parse, so it stays findable', () => {
    const read = readUserModule({ id: 'user.x', script: 'name Half-written rule\nwhen nonsense is 1' })
    expect(read.module).toBeUndefined()
    expect(read.title).toBe('Half-written rule')
    expect(read.problems.length).toBeGreaterThan(0)
  })

  it('marks a rule as the user’s own, which is what makes it editable', () => {
    const read = readUserModule({ id: 'user.x', script: divxRule })
    expect(read.module?.source).toBe('custom')
  })

  it('gives a new rule an id from its name, and keeps it unique', () => {
    expect(newUserModuleId('No commentary', [])).toBe('user.no-commentary')
    expect(newUserModuleId('No commentary', ['user.no-commentary'])).toBe('user.no-commentary-2')
    expect(newUserModuleId('!!!', [])).toBe('user.rule')
  })
})
