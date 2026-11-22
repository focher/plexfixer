import { useState } from 'react'
import type { AppSettings } from '@shared/types.js'
import { catalogFor } from '@shared/plex/catalog/resolve.js'
import { isChanged, registerCheckScript, resetEntry, setField } from '@shared/plex/catalog/edit.js'
import { checkScriptFlag, parseManifest, type ScriptInfo, type ScriptKind } from '@shared/plex/scripts/manifest.js'
import { draftOf, emptyDraft } from '@shared/plex/scripts/draft.js'
import type { ModuleDescription } from '@shared/plex/modules/framework.js'
import { FlagEditor, RecheckToggle, ScriptParamEditor } from './ParamEditor.js'
import ScriptForm, { type ScriptFormStart } from './ScriptForm.js'

type OnChange = (patch: Partial<AppSettings>) => void

const TRUST_LABEL: Record<ScriptInfo['trust'], string> = {
  approved: 'Approved',
  unapproved: 'Not approved',
  changed: 'Changed since approved',
  broken: 'Will not run'
}

const WORDING: Record<
  ScriptKind,
  { heading: string; hint: React.ReactNode; add: string; example: { id: string; label: string }; empty: string }
> = {
  checks: {
    heading: 'Check scripts — your own checks',
    hint: (
      <>
        A check script looks at a file and reports flags, which become chips and can be bound to a repair like any
        other. It runs when a file is scanned — once per file, and again only when the file, the script or its
        settings change — so a slow script slows only the first scan.
      </>
    ),
    add: 'New check script',
    example: { id: 'subtitle-ads', label: 'Add the subtitle adverts example' },
    empty: 'No check scripts yet.'
  },
  repairs: {
    heading: 'Repair scripts — your own repairs',
    hint: (
      <>
        A repair script is handed a copy of the file and writes the repaired one. It runs only for the flags you bind
        to it — open a check, or a check script, and pick the script as a flag&rsquo;s repair.
      </>
    ),
    add: 'New repair script',
    example: { id: 'subtitle-scrub', label: 'Add the subtitle scrub example' },
    empty: 'No repair scripts yet.'
  }
}

/**
 * The user's scripts of one kind: approving them, switching them on and off,
 * their settings — and for a check script, the flags it raises.
 *
 * A script is a folder in the app's data directory, not a setting, so the
 * list is read from disk; everything the user decides about one is written to
 * the catalog like any built-in module.
 */
export default function ScriptsSection({
  kind,
  scripts,
  repairScripts,
  error,
  onReload,
  onError,
  settings,
  onChange,
  onCommit,
  Row
}: {
  kind: ScriptKind
  scripts: readonly ScriptInfo[]
  /** What a check script's flags can be bound to. */
  repairScripts: readonly ScriptInfo[]
  error?: string
  onReload: () => Promise<void>
  onError: (message: string) => void
  settings: AppSettings
  /** Changes held with the rest of the section until it is saved. */
  onChange: OnChange
  /** Changes that go through at once: approving a check script registers its flags. */
  onCommit: (change: (patch: AppSettings['catalog']) => AppSettings['catalog']) => void
  Row: (props: {
    module: ModuleDescription
    enabled: boolean
    problems?: { line: number; message: string }[]
    reports: { label: string; codes: readonly string[] }
    onToggle: (enabled: boolean) => void
    onReset?: () => void
    children?: React.ReactNode
  }) => React.JSX.Element
}): React.JSX.Element {
  const catalog = catalogFor(settings)
  const section = kind === 'checks' ? 'checks' : 'repairs'
  const wording = WORDING[kind]
  const [form, setForm] = useState<ScriptFormStart>()

  // What a repair script can say it is written for: every flag there is.
  const knownFlags = Object.entries(catalog.flags).map(([id, flag]) => ({ id, label: `${flag.label} (${id})` }))

  const openNew = (): void => setForm({ draft: emptyDraft(kind), files: [] })
  const openEdit = async (script: ScriptInfo): Promise<void> => {
    try {
      const source = await window.plexfixer.scripts.read(kind, script.id)
      const read = source.manifest !== undefined ? parseManifest(source.manifest, script.id, kind) : undefined
      // A script whose manifest will not read is opened as new under its own id, to be put right.
      const draft = read?.manifest
        ? draftOf(read.manifest, kind)
        : { ...emptyDraft(kind), id: script.id, idFromName: false, name: script.id, entry: '' }
      setForm({ draft, files: source.files, previousId: script.id })
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  const addExample = async (): Promise<void> => {
    try {
      await window.plexfixer.scripts.addExample(kind, wording.example.id)
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure))
    }
    await onReload()
  }
  const closeForm = async (): Promise<void> => {
    setForm(undefined)
    await onReload()
  }

  const flagsOf = (script: ScriptInfo): string[] =>
    (script.manifest?.raises ?? []).map((flag) => checkScriptFlag(script.id, flag.code))

  const approve = async (script: ScriptInfo): Promise<void> => {
    try {
      const approved = await window.plexfixer.scripts.approve(kind, script.id)
      // A check script that has just been approved is switched on, and its
      // flags named from its manifest, so the next scan runs it.
      if (approved && kind === 'checks' && script.manifest) {
        const flags = script.manifest.raises.map((flag) => ({
          id: checkScriptFlag(script.id, flag.code),
          label: flag.label,
          hint: flag.hint,
          category: flag.category
        }))
        onCommit((patch) => registerCheckScript(patch, script.repairId, flags))
      }
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure))
    }
    await onReload()
  }

  const revoke = async (script: ScriptInfo): Promise<void> => {
    await window.plexfixer.scripts.revoke(kind, script.id).catch(() => undefined)
    await onReload()
  }

  const boundTo = (repairId: string): string[] =>
    Object.entries(catalog.flags)
      .filter(([, flag]) => flag.repair === repairId)
      .map(([code]) => code)

  return (
    <>
      <h4 className="modules-heading">{wording.heading}</h4>
      <p className="section-hint">
        {wording.hint} A script runs only after you approve it, only on this computer, and changing any of its files
        withdraws the approval.
      </p>
      <div className="modules-actions">
        <button onClick={openNew} disabled={form !== undefined}>
          {wording.add}
        </button>
        {scripts.some((script) => script.id === wording.example.id) ? null : (
          <button className="ghost" onClick={() => void addExample()}>
            {wording.example.label}
          </button>
        )}
        <button className="ghost" onClick={() => void onReload()}>
          Reload
        </button>
        {error ? <span className="muted">{error}</span> : null}
      </div>
      {form ? (
        <ScriptForm
          key={form.previousId ?? 'new'}
          start={form}
          flags={knownFlags}
          onSaved={closeForm}
          onDeleted={closeForm}
          onCancel={() => setForm(undefined)}
        />
      ) : null}
      {scripts.length > 0 ? (
        <div className="modules">
          {scripts.map((script) => {
            const manifest = script.manifest
            const reports =
              kind === 'checks'
                ? { label: 'Reports', codes: flagsOf(script) }
                : { label: 'Bound to', codes: boundTo(script.repairId).length > 0 ? boundTo(script.repairId) : ['no flags yet'] }
            // A repair script is on unless switched off; a check script only once approved and switched on.
            const on =
              script.trust !== 'broken' &&
              (kind === 'checks'
                ? catalog.checks[script.repairId]?.enabled === true
                : catalog.repairs[script.repairId]?.enabled !== false)
            return (
              <Row
                key={script.id}
                module={{
                  id: script.repairId,
                  title: `${manifest?.name ?? script.id} — ${TRUST_LABEL[script.trust]}`,
                  summary: manifest?.summary || (script.problems[0] ?? ''),
                  whatItDoes: manifest?.whatItDoes ?? 'Nothing, until the problems below are fixed.',
                  howItWorks:
                    manifest?.howItWorks || `Runs ${manifest?.command.join(' ').replace('{pluginDir}/', '') ?? '(no command)'}.`,
                  ifDisabled: manifest?.ifDisabled ?? 'It is already not running.'
                }}
                enabled={on}
                problems={script.problems.map((message) => ({ line: 0, message }))}
                reports={reports}
                onToggle={(enabled) => onChange({ catalog: setField(settings.catalog, section, script.repairId, 'enabled', enabled) })}
                onReset={
                  isChanged(settings.catalog, section, script.repairId)
                    ? () => onChange({ catalog: resetEntry(settings.catalog, section, script.repairId) })
                    : undefined
                }
              >
                <div className="modules-actions">
                  <button className="ghost" disabled={form !== undefined} onClick={() => void openEdit(script)}>
                    Edit script
                  </button>
                  {script.trust === 'unapproved' || script.trust === 'changed' ? (
                    <button onClick={() => void approve(script)}>Review and approve…</button>
                  ) : null}
                  {script.trust === 'approved' ? (
                    <button className="ghost" onClick={() => void revoke(script)}>
                      Withdraw approval
                    </button>
                  ) : null}
                  {kind === 'repairs' && manifest && manifest.suggestedFlags.length > 0 ? (
                    <span className="muted">Written for: {manifest.suggestedFlags.join(', ')}</span>
                  ) : null}
                </div>
                <ScriptParamEditor script={script} settings={settings} onChange={onChange} />
                {kind === 'checks' ? (
                  <FlagEditor flags={flagsOf(script)} settings={settings} scripts={repairScripts} onChange={onChange} />
                ) : (
                  <RecheckToggle id={script.repairId} settings={settings} onChange={onChange} />
                )}
              </Row>
            )
          })}
        </div>
      ) : (
        <p className="muted modules-empty">{wording.empty}</p>
      )}
    </>
  )
}
