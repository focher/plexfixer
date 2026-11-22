import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseManifest, type ScriptKind } from '@shared/plex/scripts/manifest.js'
import { draftOf, emptyDraft, manifestOf, slugOf, type ScriptDraft } from '@shared/plex/scripts/draft.js'

const example = (kind: ScriptKind, id: string) => {
  const read = parseManifest(readFileSync(resolve(__dirname, `../examples/${kind}/${id}/plugin.json`), 'utf8'), id, kind)
  if (!read.manifest) throw new Error(read.problems.join('; '))
  return read.manifest
}

const named = (kind: ScriptKind, name: string, extra: Partial<ScriptDraft> = {}): ScriptDraft => ({
  ...emptyDraft(kind),
  name,
  id: slugOf(name),
  raises: kind === 'checks' ? [{ code: 'found', label: 'Found it', hint: '', category: 'custom', severity: 'warning' }] : [],
  ...extra
})

describe('a script drafted in the form', () => {
  it.each([
    ['checks', 'subtitle-ads'],
    ['repairs', 'subtitle-scrub']
  ] as const)('saves the %s example as the manifest it was loaded from', (kind, id) => {
    const manifest = example(kind, id)
    const saved = manifestOf(draftOf(manifest, kind))
    expect(saved.problems).toEqual([])
    expect(saved.manifest).toEqual(manifest)
  })

  it('names the id after the script', () => {
    expect(slugOf('Subtitle Adverts — v2!')).toBe('subtitle-adverts-v2')
    expect(slugOf('---')).toBe('')
  })

  it('runs the entry file from the script folder', () => {
    const saved = manifestOf(named('repairs', 'Scrub', { entry: 'scrub.py', args: ['--fast'] }))
    expect(saved.manifest?.command).toEqual(['python3', '{pluginDir}/scrub.py', '--fast'])
    expect(draftOf(saved.manifest!, 'repairs')).toMatchObject({ program: 'python3', entry: 'scrub.py', args: ['--fast'] })
  })

  it('says what is missing rather than saving', () => {
    expect(manifestOf(emptyDraft('repairs')).problems).toContain('Give the script a name.')
    expect(manifestOf(named('checks', 'Check', { raises: [] })).problems).toContain(
      'A check script needs at least one flag it can raise.'
    )
  })

  it('refuses a flag or a setting listed twice', () => {
    const flag = { code: 'x', label: 'X', hint: '', category: 'custom', severity: 'info' } as const
    expect(manifestOf(named('checks', 'Check', { raises: [flag, flag] })).problems).toContain('Flag "x" is listed twice.')
    const param = { key: 'level', spec: { type: 'number', label: 'Level' }, value: 1 } as const
    expect(manifestOf(named('repairs', 'Fix', { params: [param, param] })).problems).toContain(
      'Setting "level" is listed twice.'
    )
  })

  it('refuses a default its own setting would not accept', () => {
    const param = { key: 'level', spec: { type: 'number', label: 'Level', min: 1, max: 5 }, value: 9 } as const
    expect(manifestOf(named('repairs', 'Fix', { params: [param] })).problems).toEqual([
      'params.level: needs a "default" that fits its type'
    ])
  })
})
