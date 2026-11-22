/**
 * Module parameters: the schema is in the module, the values are in
 * `default.json`, and a bad configured value costs only itself.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, migrateSettings, settingsWith, withDefaults } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { changedCount, isChanged, resetEntry, resetSection, setField, setParam } from '@shared/plex/catalog/edit.js'
import { DEFAULT_CATALOG, catalogFor } from '@shared/plex/catalog/resolve.js'
import { paramsFor } from '@shared/plex/modules/module-params.js'
import { resolveParams, shippedParamProblems, validateParam, type ParamSpec } from '@shared/plex/modules/params.js'
import { CHECK_MODULES, REPAIR_MODULES, moduleById } from '@shared/plex/modules/registry.js'
import { audio, mainAudio, mkv, mp4, video } from './fixtures.js'

describe('validateParam', () => {
  const level: ParamSpec = { type: 'number', label: '', options: [{ value: 41, label: '4.1' }, { value: 51, label: '5.1' }] }
  const channels: ParamSpec = { type: 'number', label: '', min: 1, max: 16 }

  it('holds a number to its options or its range', () => {
    expect(validateParam(level, 41)).toBe(true)
    expect(validateParam(level, 42)).toBe(false)
    expect(validateParam(channels, 8)).toBe(true)
    expect(validateParam(channels, 0)).toBe(false)
    expect(validateParam(channels, Number.NaN)).toBe(false)
  })

  it('holds the other kinds to their type', () => {
    expect(validateParam({ type: 'boolean', label: '' }, true)).toBe(true)
    expect(validateParam({ type: 'boolean', label: '' }, 'yes')).toBe(false)
    expect(validateParam({ type: 'list', label: '' }, ['a', 'b'])).toBe(true)
    expect(validateParam({ type: 'list', label: '' }, ['a', 3])).toBe(false)
  })
})

describe('resolveParams', () => {
  const schema = { maxChannels: { type: 'number', label: '', min: 1, max: 16 } } as const

  it('takes a valid configured value', () => {
    expect(resolveParams(schema, { maxChannels: 6 }, { maxChannels: 8 })).toEqual({ maxChannels: 8 })
  })

  it('falls back to the shipped value for an invalid one', () => {
    expect(resolveParams(schema, { maxChannels: 6 }, { maxChannels: 99 })).toEqual({ maxChannels: 6 })
    expect(resolveParams(schema, { maxChannels: 6 }, undefined)).toEqual({ maxChannels: 6 })
  })
})

describe('default.json parameters', () => {
  it('gives every module parameter a valid shipped value, and sets nothing a module lacks', () => {
    const problems = [
      ...CHECK_MODULES.flatMap((m) => shippedParamProblems(m.id, m.params ?? {}, DEFAULT_CATALOG.checks[m.id]?.params)),
      ...REPAIR_MODULES.flatMap((m) => shippedParamProblems(m.id, m.params ?? {}, DEFAULT_CATALOG.repairs[m.id]?.params))
    ]
    expect(problems).toEqual([])
  })
})

describe('parameters drive the checks', () => {
  const hevc = mkv([video({ language: 'eng', codec: 'hevc', profile: 'Main 10' }), audio({ index: 1 })])
  const codes = (result: ReturnType<typeof analyzeFile>) => result.findings.map((f) => f.code)

  it('changes what a check flags', () => {
    expect(codes(analyzeFile(hevc, DEFAULT_SETTINGS))).not.toContain('video-codec-limited')
    const strict = { ...DEFAULT_SETTINGS, catalog: setParam({}, 'checks', 'check.video-codec', 'allowHevc', false) }
    expect(codes(analyzeFile(hevc, strict))).toContain('video-codec-limited')
  })

  it('lets each audio module have its own channel ceiling', () => {
    const eight = mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng', channels: 8 })])
    expect(codes(analyzeFile(eight, DEFAULT_SETTINGS))).toContain('audio-channels-high')
    const roomy = { ...DEFAULT_SETTINGS, catalog: setParam({}, 'checks', 'check.audio-channels', 'maxChannels', 8) }
    expect(codes(analyzeFile(eight, roomy))).not.toContain('audio-channels-high')
  })
})

describe('migrateSettings', () => {
  it('moves an old threshold into the catalog', () => {
    const settings = withDefaults({ maxH264Level: 40 })
    const level = moduleById('check.video-h264-level')
    expect(level && paramsFor(level, 'checks', settings).maxLevel).toBe(40)
    expect('maxH264Level' in settings).toBe(false)
  })

  it('does not store an old value equal to the shipped one', () => {
    expect(withDefaults({ maxH264Level: 41, allowHevc: true }).catalog).toEqual({})
  })

  it('lets a value already in the catalog win, so running it twice changes nothing', () => {
    const once = migrateSettings({ maxHeight: 1080 })
    const twice = migrateSettings({ ...once, maxHeight: 720 })
    expect(twice.catalog).toEqual(once.catalog)
    expect(migrateSettings(once)).toEqual(once)
  })

  it('moves built-in modules out of disabledModules, and leaves your rules there', () => {
    const settings = withDefaults({ disabledModules: ['check.mp4-faststart', 'user.my-rule'] })
    expect(settings.disabledModules).toEqual(['user.my-rule'])
    expect(catalogFor(settings).checks['check.mp4-faststart']?.enabled).toBe(false)
  })

  it('keeps the shipped behaviour for an old settings file that changed nothing', () => {
    const file = mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: false })
    expect(analyzeFile(file, settingsWith({ remuxMkvToMp4: true }))).toEqual(analyzeFile(file, DEFAULT_SETTINGS))
  })
})

describe('editing the patch', () => {
  it('stores only what differs from the shipped value', () => {
    const changed = setParam({}, 'checks', 'check.video-resolution', 'maxHeight', 1080)
    expect(changed).toEqual({ checks: { 'check.video-resolution': { params: { maxHeight: 1080 } } } })
    expect(setParam(changed, 'checks', 'check.video-resolution', 'maxHeight', 2160)).toEqual({})
  })

  it('drops a field set back to its default, and the entry with it', () => {
    const off = setField({}, 'flags', 'mp4-not-faststart', 'keep', false)
    expect(isChanged(off, 'flags', 'mp4-not-faststart')).toBe(true)
    expect(setField(off, 'flags', 'mp4-not-faststart', 'keep', true)).toEqual({})
  })

  it('resets one entry or a whole section', () => {
    const patch = setField(setField({}, 'flags', 'video-missing', 'label', 'x'), 'repairs', 'repair.retag-hevc', 'recheck', false)
    expect(changedCount(patch, 'flags')).toBe(1)
    expect(resetEntry(patch, 'flags', 'video-missing')).toEqual({
      repairs: { 'repair.retag-hevc': { recheck: false } }
    })
    expect(resetSection(patch, 'repairs')).toEqual({ flags: { 'video-missing': { label: 'x' } } })
  })
})
