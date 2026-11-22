import type { AppSettings } from '@shared/types.js'
import { catalogFor } from '@shared/plex/catalog/resolve.js'
import { isChanged, registerCheckScript, resetEntry, setField } from '@shared/plex/catalog/edit.js'
import { checkScriptFlag, type ScriptInfo, type ScriptKind } from '@shared/plex/scripts/manifest.js'
import type { ModuleDescription } from '@shared/plex/modules/framework.js'
import { FlagEditor, RecheckToggle, ScriptParamEditor } from './ParamEditor.js'

type OnChange = (patch: Partial<AppSettings>) => void

const TRUST_LABEL: Record<ScriptInfo['trust'], string> = {
  approved: 'Approved',
  unapproved: 'Not approved',
  changed: 'Changed since approved',
  broken: 'Will not run'
}

const WORDING: Record<ScriptKind, { heading: string; hint: React.ReactNode; folder: string; empty: string }> = {
  checks: {
    heading: 'Check scripts — your own checks',
    hint: (
      <>
        A check script looks at a file and reports flags, which become chips and can be bound to a repair like any
        other. It runs when a file is scanned — once per file, and again only when the file, the script or its
        settings change — so a slow script slows only the first scan. Each needs a{' '}
        <span className="mono">plugin.json</span> that lists the flags it can raise.
      </>
    ),
    folder: 'Open checks folder',
    empty: 'No check scripts yet. Put one in the checks folder and press Reload.'
  },
  repairs: {
    heading: 'Repair scripts — your own repairs',
    hint: (
      <>
        A repair script is handed a copy of the file and writes the repaired one. It runs only for the flags you bind
        to it — open a check, or a check script, and pick the script as a flag&rsquo;s repair.
      </>
    ),
    folder: 'Open repairs folder',
    empty: 'No repair scripts yet. Put one in the repairs folder and press Reload.'
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
  onChange: OnChange
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

  const flagsOf = (script: ScriptInfo): string[] =>
    (script.manifest?.raises ?? []).map((flag) => checkScriptFlag(script.id, flag.code))

  const approve = async (script: ScriptInfo): Promise<void> => {
    try {
      const approved = await window.plexfixer.scripts.approve(kind, script.id)
      // A check script that has just been approved is switched on, and its
      // flags named from its manifest, so the next scan runs it.
      if (approved && kind === 'checks' && script.manifest) {
        onChange({
          catalog: registerCheckScript(
            settings.catalog,
            script.repairId,
            script.manifest.raises.map((flag) => ({
              id: checkScriptFlag(script.id, flag.code),
              label: flag.label,
              hint: flag.hint,
              category: flag.category
            }))
          )
        })
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
        <button className="ghost" onClick={() => void window.plexfixer.scripts.openFolder(kind)}>
          {wording.folder}
        </button>
        <button className="ghost" onClick={() => void onReload()}>
          Reload
        </button>
        {error ? <span className="muted">{error}</span> : null}
      </div>
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
                    manifest?.howItWorks || `Runs ${manifest?.command.join(' ') ?? '(no command)'} in ${script.dir}.`,
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
