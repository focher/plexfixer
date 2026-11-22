/**
 * The catalog: `default.json` has to describe the app exactly, a patch has to
 * change only what it names, and the shipped status rules have to give the
 * statuses the app gave before they were data.
 */

import { describe, expect, it } from 'vitest'
import defaultJson from '@shared/plex/catalog/default.json'
import { DEFAULT_SETTINGS, settingsWith } from '@shared/defaults.js'
import { analyzeFile } from '@shared/plex/analyze.js'
import { isBlocked } from '@shared/plex/blocked.js'
import { matchesCondition, statusIdOf } from '@shared/plex/catalog/match.js'
import {
  DEFAULT_CATALOG,
  DEFAULT_CATALOG_RESULT,
  catalogFor,
  parseCatalog,
  resolveCatalog
} from '@shared/plex/catalog/resolve.js'
import type { CatalogPatch, StatusMatch } from '@shared/plex/catalog/types.js'
import { CHECK_MODULES, REPAIR_MODULES } from '@shared/plex/modules/registry.js'
import type { AnalysisResult, AppSettings, MediaFile } from '@shared/types.js'
import { audio, coverArt, flags, mainAudio, mkv, mp4, subtitle, video } from './fixtures.js'

const withCatalog = (catalog: CatalogPatch, patch: Parameters<typeof settingsWith>[0] = {}): AppSettings =>
  settingsWith({ ...patch, catalog })

describe('default.json', () => {
  it('parses with no problems', () => {
    expect(DEFAULT_CATALOG_RESULT.problems).toEqual([])
  })

  it('lists every built-in check and repair, and nothing else', () => {
    expect(Object.keys(DEFAULT_CATALOG.checks).sort()).toEqual(CHECK_MODULES.map((m) => m.id).sort())
    expect(Object.keys(DEFAULT_CATALOG.repairs).sort()).toEqual(REPAIR_MODULES.map((m) => m.id).sort())
  })

  it('has a flag for every code a check raises, and no flag nothing raises', () => {
    const raised = new Set(CHECK_MODULES.flatMap((m) => m.raises))
    expect(Object.keys(DEFAULT_CATALOG.flags).sort()).toEqual([...raised].sort())
  })

  it('binds each flag to a repair that answers it, or to nothing', () => {
    for (const [code, flag] of Object.entries(DEFAULT_CATALOG.flags)) {
      if (flag.repair === null) continue
      const repair = REPAIR_MODULES.find((m) => m.id === flag.repair)
      expect(repair?.answers, `${code} → ${flag.repair}`).toContain(code)
    }
  })

  it('leaves a flag unbound only when no repair answers it', () => {
    for (const [code, flag] of Object.entries(DEFAULT_CATALOG.flags)) {
      if (flag.repair !== null) continue
      const answering = REPAIR_MODULES.filter((m) => (m.answers as readonly string[]).includes(code))
      expect(answering, code).toEqual([])
    }
  })

  it('ends its status rules with one that always matches', () => {
    expect(DEFAULT_CATALOG.statusRules.at(-1)?.when).toEqual({ always: true })
  })
})

describe('parseCatalog', () => {
  it('reports and leaves out a broken entry rather than failing whole', () => {
    const broken = structuredClone(defaultJson) as Record<string, unknown>
    ;(broken.flags as Record<string, unknown>)['video-missing'] = { label: 3 }
    const { catalog, problems } = parseCatalog(broken)
    expect(problems).toEqual(['flags.video-missing: not a valid entry'])
    expect(catalog.flags['video-missing']).toBeUndefined()
    expect(catalog.flags['video-multiple']).toBeDefined()
  })

  it('refuses a status rule that names no status', () => {
    const broken = structuredClone(defaultJson) as Record<string, unknown>
    broken.statusRules = [{ status: 'nowhere', when: { always: true } }]
    expect(parseCatalog(broken).problems).toContain('statusRules[0]: "status" must name a status')
  })
})

describe('resolveCatalog', () => {
  it('is the defaults when there is no patch, which is what reset means', () => {
    expect(resolveCatalog(DEFAULT_CATALOG, {}).catalog).toEqual(DEFAULT_CATALOG)
    expect(resolveCatalog(DEFAULT_CATALOG, undefined).catalog).toEqual(DEFAULT_CATALOG)
  })

  it('changes only the fields a patch names', () => {
    const { catalog, problems } = resolveCatalog(DEFAULT_CATALOG, {
      flags: { 'mp4-not-faststart': { label: 'Slow start' } }
    })
    expect(problems).toEqual([])
    expect(catalog.flags['mp4-not-faststart']).toEqual({
      ...DEFAULT_CATALOG.flags['mp4-not-faststart'],
      label: 'Slow start'
    })
    expect(catalog.flags['video-missing']).toEqual(DEFAULT_CATALOG.flags['video-missing'])
  })

  it('drops entries for ids that no longer exist, and bad values, saying so', () => {
    const { catalog, problems } = resolveCatalog(DEFAULT_CATALOG, {
      checks: { 'check.gone': { enabled: false } },
      flags: { 'video-missing': { severity: 'catastrophic' as never } }
    })
    expect(problems).toEqual([
      'checks.check.gone: no such entry; ignored',
      'flags.video-missing.severity: not a valid value; ignored'
    ])
    expect(catalog.flags['video-missing']).toEqual(DEFAULT_CATALOG.flags['video-missing'])
  })

  it('lets a flag be report-only but not answered by some other built-in repair', () => {
    const { catalog, problems } = resolveCatalog(DEFAULT_CATALOG, {
      flags: {
        'mp4-not-faststart': { repair: null },
        'container-not-mp4': { repair: 'repair.transcode-video' }
      }
    })
    expect(catalog.flags['mp4-not-faststart']?.repair).toBeNull()
    expect(catalog.flags['container-not-mp4']?.repair).toBe('repair.rewrap-container')
    expect(problems).toEqual(['flags.container-not-mp4.repair: not a valid value; ignored'])
  })

  it('falls back to the shipped statuses when a patched list is broken', () => {
    const { catalog, problems } = resolveCatalog(DEFAULT_CATALOG, {
      statuses: [{ id: 'x', label: 'X', badge: 'x', hint: '', tone: 'ok', passing: true }],
      statusRules: [{ status: 'y', when: { always: true } }]
    })
    expect(problems).toHaveLength(1)
    expect(catalog.statuses).toEqual(DEFAULT_CATALOG.statuses)
  })

  it('is remembered per patch, so analysis does not resolve it per file', () => {
    const settings = withCatalog({ flags: { 'video-missing': { label: 'Nothing to watch' } } })
    expect(catalogFor(settings)).toBe(catalogFor({ ...settings }))
  })
})

/* ------------------------------------------------------------------ *
 * The shipped rules reproduce the statuses that used to be code
 * ------------------------------------------------------------------ */

/** The status logic as it was before it moved into `default.json`. */
function statusBeforeTheCatalog(result: AnalysisResult): string {
  if (result.verdict === 'ok') return 'passed'
  if (isBlocked(result)) return 'manual'
  if (result.plan.requiresTranscode) return 'reencode'
  if (result.plan.strategy !== 'none') return 'fixable'
  return 'passed'
}

const LIBRARY: { name: string; file: MediaFile; settings?: Parameters<typeof settingsWith>[0] }[] = [
  { name: 'clean mp4', file: mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]) },
  { name: 'mkv to remux', file: mkv([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]) },
  {
    name: 'index at the end',
    file: mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: false })
  },
  {
    name: 'high 10',
    file: mp4([
      video({ codec: 'h264', profile: 'high 10', bitDepth: 10, language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' })
    ])
  },
  {
    name: 'high 10, force transcode',
    file: mkv([
      video({ codec: 'h264', profile: 'high 10', bitDepth: 10, language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' })
    ]),
    settings: { defaultMode: 'force-transcode' }
  },
  {
    name: 'dolby vision 5',
    file: mkv([video({ dolbyVisionProfile: 5, language: 'eng' }), mainAudio({ index: 1, language: 'eng' })])
  },
  {
    name: 'french audio only',
    file: mp4([video({ language: 'eng', rawLanguage: 'eng' }), mainAudio({ index: 1, language: 'fre', rawLanguage: 'fra' })])
  },
  { name: 'no audio', file: mp4([video({ language: 'eng' })]) },
  { name: 'no video', file: mp4([mainAudio({ index: 0, language: 'eng' })]) },
  {
    name: 'truehd only',
    file: mkv([video({ language: 'eng' }), audio({ index: 1, codec: 'truehd', channels: 8, language: 'eng' })])
  },
  {
    name: 'truehd only, no companion track',
    file: mkv([video({ language: 'eng' }), audio({ index: 1, codec: 'truehd', channels: 8, language: 'eng' })]),
    settings: { ensureAacStereo: false }
  },
  {
    name: 'pgs and ass subtitles',
    file: mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', language: 'eng' }),
      subtitle({ index: 3, codec: 'ass', language: 'eng' })
    ])
  },
  {
    name: 'hevc hev1',
    file: mp4([
      video({ codec: 'hevc', codecTag: 'hev1', profile: 'main 10', language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' })
    ]),
    settings: { allowHevc: true }
  },
  {
    name: 'two default audio tracks, untagged',
    file: mp4([
      video({ index: 0 }),
      audio({ index: 1, codec: 'aac', disposition: flags({ default: true }) }),
      audio({ index: 2, codec: 'aac', disposition: flags({ default: true }) })
    ])
  },
  {
    name: 'cover art and interlaced',
    file: mkv([
      video({ index: 0, fieldOrder: 'tt', language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      coverArt({ index: 2 })
    ])
  },
  {
    name: 'too tall',
    file: mkv([video({ height: 2160, width: 3840, language: 'eng' }), mainAudio({ index: 1, language: 'eng' })]),
    settings: { maxHeight: 1080 }
  }
]

describe('the shipped status rules', () => {
  for (const entry of LIBRARY) {
    it(`give "${entry.name}" the status it always had`, () => {
      const result = analyzeFile(entry.file, settingsWith(entry.settings ?? {}))
      expect(statusIdOf(result, DEFAULT_CATALOG)).toBe(statusBeforeTheCatalog(result))
    })
  }

  it('cover a library that reaches every status', () => {
    const statuses = new Set(
      LIBRARY.map((entry) => statusIdOf(analyzeFile(entry.file, settingsWith(entry.settings ?? {})), DEFAULT_CATALOG))
    )
    expect([...statuses].sort()).toEqual(['fixable', 'manual', 'passed', 'reencode'])
  })
})

/* ------------------------------------------------------------------ *
 * What a patch does to a run
 * ------------------------------------------------------------------ */

describe('a patched catalog', () => {
  const slowStart = mp4([video({ language: 'eng' }), mainAudio({ index: 1, language: 'eng' })], { faststart: false })

  it('discards a flag that is not kept, and the repair it would have caused', () => {
    const before = analyzeFile(slowStart, DEFAULT_SETTINGS)
    expect(before.findings.map((f) => f.code)).toContain('mp4-not-faststart')
    expect(before.plan.strategy).toBe('remux')

    const after = analyzeFile(slowStart, withCatalog({ flags: { 'mp4-not-faststart': { keep: false } } }))
    expect(after.findings.map((f) => f.code)).not.toContain('mp4-not-faststart')
    expect(after.plan.strategy).toBe('none')
  })

  it('reports a flag made report-only, and leaves it unresolved', () => {
    const after = analyzeFile(slowStart, withCatalog({ flags: { 'mp4-not-faststart': { repair: null } } }))
    expect(after.findings.map((f) => f.code)).toContain('mp4-not-faststart')
    expect(after.plan.strategy).toBe('none')
    expect(after.plan.unresolved.map((f) => f.code)).toContain('mp4-not-faststart')
  })

  it('drops the signals of a check whose flags were all set aside', () => {
    const tagged = mp4([
      video({ codec: 'hevc', codecTag: 'hev1', profile: 'main 10', language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' })
    ])
    const settings = { allowHevc: true }
    expect(analyzeFile(tagged, settingsWith(settings)).plan.strategy).toBe('remux')
    const after = analyzeFile(tagged, withCatalog({ flags: { 'video-hevc-wrong-tag': { keep: false } } }, settings))
    expect(after.plan.strategy).toBe('none')
  })

  it('overrides a severity, which moves the file between statuses', () => {
    const frenchOnly = mp4([
      video({ language: 'eng', rawLanguage: 'eng' }),
      mainAudio({ index: 1, language: 'fre', rawLanguage: 'fra' })
    ])
    expect(statusIdOf(analyzeFile(frenchOnly, DEFAULT_SETTINGS), DEFAULT_CATALOG)).toBe('manual')
    const quiet = withCatalog({ flags: { 'preferred-audio-language-absent': { severity: 'info' } } })
    expect(statusIdOf(analyzeFile(frenchOnly, quiet), catalogFor(quiet))).toBe('passed')
  })

  it('skips a check switched off in the catalog', () => {
    const settings = withCatalog({ checks: { 'check.mp4-faststart': { enabled: false } } })
    expect(analyzeFile(slowStart, settings).findings.map((f) => f.code)).not.toContain('mp4-not-faststart')
  })

  it('leaves the flags of a repair switched off in the catalog unresolved', () => {
    const settings = withCatalog({ repairs: { 'repair.move-index-to-front': { enabled: false } } })
    expect(analyzeFile(slowStart, settings).plan.unresolved.map((f) => f.code)).toContain('mp4-not-faststart')
  })

  it('takes user statuses and rules', () => {
    const settings = withCatalog({
      statuses: [
        { id: 'slow', label: 'Slow start', badge: 'slow', hint: '', tone: 'warn', passing: false },
        { id: 'rest', label: 'Everything else', badge: 'rest', hint: '', tone: 'ok', passing: true }
      ],
      statusRules: [
        { status: 'slow', when: { any: [{ flag: ['mp4-not-faststart'] }] } },
        { status: 'rest', when: { always: true } }
      ]
    })
    const catalog = catalogFor(settings)
    expect(statusIdOf(analyzeFile(slowStart, settings), catalog)).toBe('slow')
    expect(statusIdOf(analyzeFile(mkv([video(), mainAudio({ index: 1 })]), settings), catalog)).toBe('rest')
  })
})

describe('matchesCondition', () => {
  const result = analyzeFile(
    mkv([
      video({ language: 'eng' }),
      mainAudio({ index: 1, language: 'eng' }),
      subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', language: 'eng' })
    ]),
    DEFAULT_SETTINGS
  )
  const holds = (match: StatusMatch): boolean => matchesCondition(match, result, DEFAULT_CATALOG)

  it('reads selectors by flag, category, severity and repair', () => {
    expect(holds({ any: [{ flag: ['container-not-mp4'] }] })).toBe(true)
    expect(holds({ any: [{ category: ['subtitle'] }] })).toBe(true)
    expect(holds({ any: [{ category: ['audio'] }] })).toBe(false)
    expect(holds({ any: [{ repair: ['repair.rewrap-container'] }] })).toBe(true)
    expect(holds({ none: [{ severity: ['blocker'] }] })).toBe(true)
  })

  it('needs every selector of "all" to find something', () => {
    expect(holds({ all: [{ flag: ['container-not-mp4'] }, { category: ['subtitle'] }] })).toBe(true)
    expect(holds({ all: [{ flag: ['container-not-mp4'] }, { category: ['audio'] }] })).toBe(false)
  })

  it('combines conditions', () => {
    expect(holds({ and: [{ strategy: ['remux'] }, { not: { always: true } }] })).toBe(false)
    expect(holds({ or: [{ strategy: ['transcode-video'] }, { strategy: ['remux'] }] })).toBe(true)
  })
})
