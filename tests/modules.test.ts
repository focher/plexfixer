/**
 * The module framework, and what switching a module off actually does.
 *
 * Two halves. The first is housekeeping the registry has to satisfy for the
 * Settings screen to be honest: unique ids, prose in every field, and no check
 * reporting something no repair has ever heard of. The second is the promise
 * the switches make — a check that is off reports nothing, and a repair that
 * is off leaves the problem reported and says plainly that it will not be
 * fixed.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { CHECK_MODULES, REPAIR_MODULES, ALL_MODULES, moduleById } from '@shared/plex/modules/registry.js'
import {
  initialState,
  isModuleEnabled,
  mergeSignals,
  strongerStrategy,
  withModuleEnabled
} from '@shared/plex/modules/framework.js'
import type { AppSettings, FindingCode } from '@shared/types.js'
import { audio, flags, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

const settingsWithout = (...ids: string[]): AppSettings => ({ ...DEFAULT_SETTINGS, disabledModules: ids })

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

describe('the registry', () => {
  it('gives every module an id of its own', () => {
    const ids = ALL_MODULES.map((module) => module.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('says which kind each module is in its id', () => {
    for (const module of CHECK_MODULES) expect(module.id.startsWith('check.')).toBe(true)
    for (const module of REPAIR_MODULES) expect(module.id.startsWith('repair.')).toBe(true)
  })

  it('explains every module in plain English', () => {
    for (const module of ALL_MODULES) {
      for (const [field, value] of Object.entries({
        title: module.title,
        summary: module.summary,
        whatItDoes: module.whatItDoes,
        howItWorks: module.howItWorks,
        ifDisabled: module.ifDisabled
      })) {
        expect(value.length, `${module.id} ${field}`).toBeGreaterThan(0)
        // Prose, not a sentence fragment or an identifier.
        expect(value.trim(), `${module.id} ${field}`).toBe(value)
      }
      // The summary is a line in a list, not a paragraph.
      expect(module.summary.length, module.id).toBeLessThan(90)
      expect(module.whatItDoes.length, module.id).toBeGreaterThan(80)
      expect(module.howItWorks.length, module.id).toBeGreaterThan(80)
    }
  })

  it('finds a module by its id', () => {
    expect(moduleById('check.video-codec')?.title).toBe('Video codec support')
    expect(moduleById('nothing.at.all')).toBeUndefined()
  })

  /**
   * The codes nothing repairs, because nothing can.
   *
   * Listed rather than inferred: a code quietly falling off the end of a
   * repair's `answers` would otherwise look exactly like one of these, and
   * every file carrying it would silently start reporting it as unfixable.
   */
  const NOT_REPAIRABLE: FindingCode[] = [
    'drm-protected',
    'video-missing',
    'audio-missing',
    'container-blocked-by-stream',
    'preferred-audio-language-absent',
    // Reported for somebody to act on by hand, on the metadata screen. No
    // repair could answer it: picking the right film is the whole of it.
    'metadata-missing'
  ]

  it('has a repair for everything a check reports, or says why not', () => {
    const answered = new Set(REPAIR_MODULES.flatMap((module) => module.answers))
    for (const module of CHECK_MODULES) {
      for (const code of module.raises) {
        if (NOT_REPAIRABLE.includes(code)) continue
        expect(answered.has(code), `${code} (raised by ${module.id}) has no repair`).toBe(true)
      }
    }
  })

  it('does not answer a finding nothing raises', () => {
    const raised = new Set(CHECK_MODULES.flatMap((module) => module.raises))
    // Raised by rules the user wrote, which are read out of settings rather
    // than listed here.
    raised.add('custom')
    for (const module of REPAIR_MODULES) {
      for (const code of module.answers) {
        expect(raised.has(code), `${module.id} answers ${code}, which no check raises`).toBe(true)
      }
    }
  })
})

/* ------------------------------------------------------------------ *
 * What a module hands back
 * ------------------------------------------------------------------ */

describe('folding a check’s conclusions into the state', () => {
  const base = (): ReturnType<typeof initialState> => initialState(DEFAULT_SETTINGS)

  it('lets a flag be turned on but never off', () => {
    const on = mergeSignals(base(), { needsTranscode: true })
    expect(on.needsTranscode).toBe(true)
    // A second check with nothing to say must not undo the first one.
    expect(mergeSignals(on, { needsTranscode: false }).needsTranscode).toBe(true)
    expect(mergeSignals(on, {}).needsTranscode).toBe(true)
  })

  it('appends to the lists rather than replacing them', () => {
    let state = mergeSignals(base(), { dropStreams: [2] })
    state = mergeSignals(state, { dropStreams: [3, 4] })
    expect(state.dropStreams).toEqual([2, 3, 4])
  })

  it('replaces a plain value with the newer one', () => {
    let state = mergeSignals(base(), { targetContainer: 'mkv' })
    expect(state.targetContainer).toBe('mkv')
    state = mergeSignals(state, { targetContainer: 'mp4' })
    expect(state.targetContainer).toBe('mp4')
  })

  it('leaves the state it was given alone', () => {
    const before = base()
    mergeSignals(before, { needsTranscode: true, dropStreams: [1] })
    expect(before.needsTranscode).toBe(false)
    expect(before.dropStreams).toEqual([])
  })

  it('does nothing at all when a check concluded nothing', () => {
    const before = base()
    expect(mergeSignals(before, undefined)).toBe(before)
  })
})

describe('how much work the run turns out to be', () => {
  it('takes the stronger of two answers, whichever order they arrive in', () => {
    expect(strongerStrategy('remux', 'transcode-video')).toBe('transcode-video')
    expect(strongerStrategy('transcode-video', 'remux')).toBe('transcode-video')
    expect(strongerStrategy('none', 'remux')).toBe('remux')
    expect(strongerStrategy('transcode-audio', 'remux')).toBe('transcode-audio')
    expect(strongerStrategy('none', 'none')).toBe('none')
  })
})

/* ------------------------------------------------------------------ *
 * The switches
 * ------------------------------------------------------------------ */

describe('switching a module off', () => {
  const ordinary = { id: 'check.video-codec' }
  const optIn = { id: 'check.metadata-missing', startsOff: true } as const

  it('treats anything not named as on, including a module added later', () => {
    const settings = settingsWithout('check.video-codec')
    expect(isModuleEnabled(ordinary, settings)).toBe(false)
    expect(isModuleEnabled({ id: 'check.something-invented-next-year' }, settings)).toBe(true)
  })

  it('treats a module that ships quiet as off until it is asked for', () => {
    expect(isModuleEnabled(optIn, DEFAULT_SETTINGS)).toBe(false)
    expect(isModuleEnabled(optIn, { ...DEFAULT_SETTINGS, enabledModules: [optIn.id] })).toBe(true)
    // Not in `disabledModules` is what every other module calls "on". For
    // this kind it has to mean nothing at all.
    expect(isModuleEnabled(optIn, { ...DEFAULT_SETTINGS, disabledModules: [] })).toBe(false)
  })

  it('keeps the list sorted, with no duplicates', () => {
    let settings = DEFAULT_SETTINGS
    for (const id of ['check.b', 'check.a', 'check.b']) {
      settings = { ...settings, ...withModuleEnabled({ id }, false, settings) }
    }
    expect(settings.disabledModules).toEqual(['check.a', 'check.b'])
  })

  it('removes a module from the list when it is turned back on', () => {
    const settings = { ...DEFAULT_SETTINGS, disabledModules: ['check.a', 'check.b'] }
    expect(withModuleEnabled({ id: 'check.a' }, true, settings).disabledModules).toEqual(['check.b'])
    expect(withModuleEnabled({ id: 'check.not-in-it' }, true, settings).disabledModules).toEqual([
      'check.a',
      'check.b'
    ])
  })

  it('writes an opt-in module to the other list, and clears it from the wrong one', () => {
    const confused = { ...DEFAULT_SETTINGS, disabledModules: [optIn.id], enabledModules: [] }
    expect(withModuleEnabled(optIn, true, confused)).toEqual({
      disabledModules: [],
      enabledModules: [optIn.id]
    })
    expect(withModuleEnabled(optIn, false, confused)).toEqual({ disabledModules: [], enabledModules: [] })
  })

  it('does not let an id sit in both lists at once', () => {
    const both = { ...DEFAULT_SETTINGS, disabledModules: ['check.a'], enabledModules: ['check.a'] }
    const after = withModuleEnabled({ id: 'check.a' }, true, both)
    expect(after.disabledModules).toEqual([])
    expect(after.enabledModules).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * End to end
 * ------------------------------------------------------------------ */

/** An MKV whose only problem is that it is an MKV. */
const plainMkv = (): ReturnType<typeof mkv> => mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })])

describe('a check that is switched off', () => {
  it('reports nothing, and nothing is planned for it', () => {
    const on = analyzeFile(plainMkv(), DEFAULT_SETTINGS)
    expect(on.findings.map((f) => f.code)).toContain('container-not-mp4')
    expect(on.plan.strategy).toBe('remux')

    const off = analyzeFile(plainMkv(), settingsWithout('check.container-mkv'))
    expect(off.findings.map((f) => f.code)).not.toContain('container-not-mp4')
    expect(off.plan.strategy).toBe('none')
    expect(off.verdict).toBe('ok')
  })

  it('leaves the other checks running', () => {
    const file = mp4([
      video({ codec: 'hevc', profile: 'Main 10', codecTag: 'hev1', language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' })
    ])
    const off = analyzeFile(file, settingsWithout('check.container-mkv'))
    expect(off.findings.map((f) => f.code)).toContain('video-hevc-wrong-tag')
  })
})

describe('a repair that is switched off', () => {
  it('still reports the problem, but says it will not be fixed', () => {
    const file = mp4([
      video({ codec: 'hevc', profile: 'Main 10', codecTag: 'hev1', language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' })
    ])

    const on = analyzeFile(file, DEFAULT_SETTINGS)
    expect(on.plan.strategy).toBe('remux')
    expect(on.plan.actions.some((a) => a.label.includes('retag HEVC'))).toBe(true)
    expect(on.plan.unresolved.map((f) => f.code)).not.toContain('video-hevc-wrong-tag')

    const off = analyzeFile(file, settingsWithout('repair.retag-hevc'))
    // The finding is unchanged — the file is still broken.
    expect(off.findings.map((f) => f.code)).toContain('video-hevc-wrong-tag')
    // But nothing is proposed, and it is listed as something left undone.
    expect(off.plan.actions.some((a) => a.label.includes('retag HEVC'))).toBe(false)
    expect(off.plan.unresolved.map((f) => f.code)).toContain('video-hevc-wrong-tag')
  })

  it('stops a re-encode being planned when re-encoding is switched off', () => {
    const file = mkv([video({ codec: 'mpeg2video', language: 'eng' }), mainAudio({ index: 1, language: 'eng' })])

    const on = analyzeFile(file, DEFAULT_SETTINGS)
    expect(on.plan.strategy).toBe('transcode-video')
    expect(on.plan.videoTranscode).toBeDefined()

    const off = analyzeFile(file, settingsWithout('repair.transcode-video'))
    expect(off.plan.videoTranscode).toBeUndefined()
    expect(off.plan.strategy).not.toBe('transcode-video')
    expect(off.plan.unresolved.map((f) => f.code)).toContain('video-codec-limited')
  })

  it('leaves the metadata alone when the metadata repair is off', () => {
    const file = mkv([
      video({ language: 'eng' }),
      audio({ index: 1, language: 'eng', disposition: flags({ default: false }) }),
      subtitle({ index: 2, language: 'eng' })
    ])

    const on = analyzeFile(file, DEFAULT_SETTINGS)
    expect(on.plan.actions.some((a) => a.label.startsWith('Fix '))).toBe(true)

    const off = analyzeFile(file, settingsWithout('repair.fix-track-metadata'))
    expect(off.plan.actions.some((a) => a.label.startsWith('Fix '))).toBe(false)
    expect(off.findings.some((f) => f.code === 'default-audio-missing')).toBe(true)
    expect(off.plan.unresolved.map((f) => f.code)).toContain('default-audio-missing')
  })
})
