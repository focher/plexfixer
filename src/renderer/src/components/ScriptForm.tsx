import { useState } from 'react'
import type { Severity } from '@shared/types.js'
import { FLAG_CATEGORY_LABEL, FLAG_CATEGORY_ORDER, type FlagCategory } from '@shared/plex/catalog/types.js'
import type { ParamSpec } from '@shared/plex/modules/params.js'
import type { ScriptFlag, ScriptKind } from '@shared/plex/scripts/manifest.js'
import {
  PROGRAMS,
  defaultFor,
  manifestOf,
  slugOf,
  starterSource,
  type DraftParam,
  type ScriptDraft
} from '@shared/plex/scripts/draft.js'
import type { ScriptSourceFile } from '../bridge/tauri.js'
import { ParamControl } from './ParamEditor.js'

const replaceAt = <T,>(list: readonly T[], at: number, value: T): T[] => list.map((item, i) => (i === at ? value : item))
const removeAt = <T,>(list: readonly T[], at: number): T[] => list.filter((_, i) => i !== at)

const SEVERITY_LABEL: Record<Severity, string> = { info: 'Info', warning: 'Warning', blocker: 'Blocker' }

const TYPE_LABEL: Record<ParamSpec['type'], string> = {
  number: 'Number',
  boolean: 'On / off',
  string: 'Text',
  list: 'List of text'
}

/** A file's text by name; a file that is not text has no content and is only kept or removed. */
type Files = Readonly<Record<string, { content?: string; size: number }>>

const filesOf = (list: readonly ScriptSourceFile[]): Files =>
  Object.fromEntries(list.map((file) => [file.name, { content: file.content, size: file.size }]))

/** What the form opens with: a draft, and the files it was saved with. */
export interface ScriptFormStart {
  draft: ScriptDraft
  files: readonly ScriptSourceFile[]
  /** The id it was saved under; absent for a new script. */
  previousId?: string
}

/**
 * A script, as a form: what it is called, what runs it, the script itself,
 * the settings it takes and — for a check — the flags it raises.
 *
 * Saving writes the folder and its `plugin.json`; the user never sees either.
 * A saved script still has to be approved before it runs, and saving one that
 * was approved withdraws that, because the files are no longer what was seen.
 */
export default function ScriptForm({
  start,
  flags,
  onSaved,
  onCancel,
  onDeleted
}: {
  start: ScriptFormStart
  /** Flags a repair script can say it is written for. */
  flags: readonly { id: string; label: string }[]
  onSaved: () => Promise<void>
  onCancel: () => void
  onDeleted: () => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState<ScriptDraft>(start.draft)
  const [files, setFiles] = useState<Files>(() =>
    start.previousId === undefined && start.draft.entry
      ? { [start.draft.entry]: { content: starterSource(start.draft.kind, start.draft.program), size: 0 } }
      : filesOf(start.files)
  )
  const [editingId, setEditingId] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const kind: ScriptKind = draft.kind
  const isNew = start.previousId === undefined
  const set = (patch: Partial<ScriptDraft>): void => setDraft((previous) => ({ ...previous, ...patch }))
  const otherProgram = !PROGRAMS.some((program) => program.value === draft.program)

  const entry = draft.entry.trim()
  const entryFile = entry ? files[entry] : undefined
  const built = manifestOf(draft)
  const problems = [
    ...built.problems,
    ...(entry && entryFile === undefined ? [`There is no ${entry} yet: write it below, or choose the file.`] : [])
  ]

  const setName = (name: string): void => set(draft.idFromName ? { name, id: slugOf(name) } : { name })

  /** The script file follows its name: renaming it carries its text along. */
  const setEntry = (name: string): void => {
    const moving = entryFile !== undefined && name.trim() && !(name.trim() in files)
    setFiles((previous) =>
      moving
        ? Object.fromEntries(Object.entries(previous).map(([file, value]) => [file === entry ? name.trim() : file, value]))
        : previous
    )
    set({ entry: name })
  }

  /** A new script with nothing written yet gets the starter for the program, under its usual extension. */
  const setProgram = (program: string): void => {
    const untouched = isNew && (entryFile?.content ?? '') === starterSource(kind, draft.program)
    const extension = PROGRAMS.find((choice) => choice.value === program)?.extension
    const nextEntry = untouched && extension && entry ? entry.replace(/\.[^.]*$/, '') + extension : entry
    if (untouched && nextEntry) {
      setFiles((previous) => ({
        ...Object.fromEntries(Object.entries(previous).filter(([file]) => file !== entry)),
        [nextEntry]: { content: starterSource(kind, program), size: 0 }
      }))
    }
    set({ program, entry: nextEntry })
  }

  const importFile = async (): Promise<void> => {
    try {
      const picked = await window.plexfixer.scripts.importFile()
      if (!picked) return
      // A script still on its starter takes the picked file as the script itself, and the starter goes.
      const replacesStarter = isNew && (entryFile?.content ?? '') === starterSource(kind, draft.program)
      setFiles((previous) => ({
        ...Object.fromEntries(Object.entries(previous).filter(([name]) => !(replacesStarter && name === entry))),
        [picked.name]: { content: picked.content, size: picked.size }
      }))
      if (!entry || replacesStarter || entryFile === undefined) set({ entry: picked.name })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const save = async (): Promise<void> => {
    if (problems.length > 0) return
    const original = filesOf(start.files)
    const write = Object.fromEntries(
      Object.entries(files)
        .filter(([name, file]) => file.content !== undefined && file.content !== original[name]?.content)
        .map(([name, file]) => [name, file.content as string])
    )
    const remove = Object.keys(original).filter((name) => !(name in files))
    setBusy(true)
    try {
      await window.plexfixer.scripts.save({
        kind,
        id: draft.id,
        ...(start.previousId !== undefined ? { previousId: start.previousId } : {}),
        manifest: built.source,
        write,
        remove
      })
      await onSaved()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (start.previousId === undefined) return
    try {
      if (await window.plexfixer.scripts.remove(kind, start.previousId)) await onDeleted()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const setParam = (at: number, param: DraftParam): void => set({ params: replaceAt(draft.params, at, param) })
  const setFlag = (at: number, flag: ScriptFlag): void => set({ raises: replaceAt(draft.raises, at, flag) })
  const others = Object.entries(files).filter(([name]) => name !== entry)

  return (
    <div className="script-form">
      <h4 className="modules-heading">
        {isNew ? `New ${kind === 'checks' ? 'check' : 'repair'} script` : `Editing ${start.draft.name || start.draft.id}`}
      </h4>

      <fieldset>
        <legend>About it</legend>
        <div className="script-form-grid">
          <label>
            Name
            <input type="text" value={draft.name} autoFocus={isNew} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Version
            <input type="text" value={draft.version} onChange={(event) => set({ version: event.target.value })} />
          </label>
          <div className="script-form-id muted">
            {editingId ? (
              <label>
                Id
                <input
                  type="text"
                  className="mono"
                  value={draft.id}
                  onChange={(event) => set({ id: slugOf(event.target.value), idFromName: false })}
                />
              </label>
            ) : (
              <>
                Id <span className="mono">{draft.id || '—'}</span>{' '}
                <button type="button" className="link" onClick={() => setEditingId(true)}>
                  change
                </button>
              </>
            )}
          </div>
          <label className="wide">
            In one line
            <input type="text" value={draft.summary} onChange={(event) => set({ summary: event.target.value })} />
          </label>
          <label className="wide">
            What it does
            <textarea rows={2} value={draft.whatItDoes} onChange={(event) => set({ whatItDoes: event.target.value })} />
          </label>
          <label className="wide">
            How it works
            <textarea rows={2} value={draft.howItWorks} onChange={(event) => set({ howItWorks: event.target.value })} />
          </label>
          <label className="wide">
            If you turn it off
            <input type="text" value={draft.ifDisabled} onChange={(event) => set({ ifDisabled: event.target.value })} />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>How it runs</legend>
        <div className="script-form-grid">
          <label>
            Run with
            <select
              value={otherProgram ? '' : draft.program}
              onChange={(event) => setProgram(event.target.value)}
            >
              {PROGRAMS.map((program) => (
                <option key={program.value} value={program.value}>
                  {program.label}
                </option>
              ))}
              <option value="">Another program…</option>
            </select>
          </label>
          {otherProgram ? (
            <label>
              Program
              <input
                type="text"
                className="mono"
                value={draft.program}
                placeholder="e.g. ruby"
                onChange={(event) => set({ program: event.target.value })}
              />
            </label>
          ) : null}
          <label>
            Script file
            <input type="text" className="mono" value={draft.entry} onChange={(event) => setEntry(event.target.value)} />
          </label>
          <label>
            Extra arguments
            <input
              type="text"
              className="mono"
              value={draft.args.join(' ')}
              onChange={(event) => set({ args: event.target.value.split(/\s+/).filter((arg) => arg.length > 0) })}
            />
          </label>
          <label>
            Time limit (seconds)
            <input
              type="number"
              min={1}
              value={draft.timeoutSeconds ?? ''}
              placeholder="none"
              onChange={(event) =>
                set({ timeoutSeconds: event.target.value === '' ? undefined : Number(event.target.value) })
              }
            />
          </label>
        </div>
        {entry ? (
          entryFile === undefined || entryFile.content !== undefined ? (
            <label className="script-form-source">
              {entry}
              <textarea
                className="mono"
                rows={14}
                spellCheck={false}
                value={entryFile?.content ?? ''}
                onChange={(event) =>
                  setFiles((previous) => ({ ...previous, [entry]: { content: event.target.value, size: event.target.value.length } }))
                }
              />
            </label>
          ) : (
            <p className="muted">{entry} is not a text file, so it cannot be edited here. Choose another to replace it.</p>
          )
        ) : null}
        <div className="modules-actions">
          <button type="button" className="ghost" onClick={() => void importFile()}>
            Choose a file…
          </button>
          <span className="muted">Copies a file from your computer into the script.</span>
        </div>
        {others.length > 0 ? (
          <ul className="script-form-files">
            {others.map(([name, file]) => (
              <li key={name}>
                <span className="mono">{name}</span>
                <span className="muted">{file.size} bytes</span>
                <button type="button" className="ghost" onClick={() => setEntry(name)}>
                  Make it the script
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setFiles((previous) => Object.fromEntries(Object.entries(previous).filter(([other]) => other !== name)))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>

      <fieldset>
        <legend>Settings it takes</legend>
        <p className="section-hint">
          Each one appears under the script once it is saved, for you to change without touching the script. The script
          is given them by name.
        </p>
        {draft.params.map((param, at) => {
          const setSpec = (spec: ParamSpec): void => setParam(at, { ...param, spec })
          return (
            <div className="script-form-row" key={at}>
              <label>
                Name in the script
                <input
                  type="text"
                  className="mono"
                  value={param.key}
                  onChange={(event) => setParam(at, { ...param, key: event.target.value.replace(/[^A-Za-z0-9_]/g, '') })}
                />
              </label>
              <label>
                Label
                <input type="text" value={param.spec.label} onChange={(event) => setSpec({ ...param.spec, label: event.target.value })} />
              </label>
              <label>
                Kind
                <select
                  value={param.spec.type}
                  onChange={(event) => {
                    const spec = {
                      type: event.target.value,
                      label: param.spec.label,
                      ...(param.spec.help ? { help: param.spec.help } : {})
                    } as ParamSpec
                    setParam(at, { ...param, spec, value: defaultFor(spec) })
                  }}
                >
                  {(Object.keys(TYPE_LABEL) as ParamSpec['type'][]).map((type) => (
                    <option key={type} value={type}>
                      {TYPE_LABEL[type]}
                    </option>
                  ))}
                </select>
              </label>
              {param.spec.type === 'number' ? (
                <>
                  <label>
                    Lowest
                    <input
                      type="number"
                      value={param.spec.min ?? ''}
                      onChange={(event) => {
                        const { min: _min, ...rest } = param.spec as Extract<ParamSpec, { type: 'number' }>
                        setSpec(event.target.value === '' ? rest : { ...rest, min: Number(event.target.value) })
                      }}
                    />
                  </label>
                  <label>
                    Highest
                    <input
                      type="number"
                      value={param.spec.max ?? ''}
                      onChange={(event) => {
                        const { max: _max, ...rest } = param.spec as Extract<ParamSpec, { type: 'number' }>
                        setSpec(event.target.value === '' ? rest : { ...rest, max: Number(event.target.value) })
                      }}
                    />
                  </label>
                </>
              ) : null}
              <label className="wide">
                Help
                <input
                  type="text"
                  value={param.spec.help ?? ''}
                  onChange={(event) => {
                    const { help: _help, ...rest } = param.spec
                    setSpec((event.target.value ? { ...rest, help: event.target.value } : rest) as ParamSpec)
                  }}
                />
              </label>
              <div className="wide script-form-default">
                <span>Starts as</span>
                <ParamControl spec={param.spec} value={param.value} onChange={(value) => setParam(at, { ...param, value })} />
              </div>
              <button type="button" className="ghost" onClick={() => set({ params: removeAt(draft.params, at) })}>
                Remove setting
              </button>
            </div>
          )
        })}
        <div className="modules-actions">
          <button
            type="button"
            className="ghost"
            onClick={() =>
              set({
                params: [
                  ...draft.params,
                  { key: `setting${draft.params.length + 1}`, spec: { type: 'string', label: 'New setting' }, value: '' }
                ]
              })
            }
          >
            Add a setting
          </button>
        </div>
      </fieldset>

      {kind === 'checks' ? (
        <fieldset>
          <legend>Flags it can raise</legend>
          <p className="section-hint">
            The script can only report the flags listed here. Each becomes a chip and can be given a repair, like any
            other flag.
          </p>
          {draft.raises.map((flag, at) => (
            <div className="script-form-row" key={at}>
              <label>
                Code
                <input
                  type="text"
                  className="mono"
                  value={flag.code}
                  onChange={(event) => setFlag(at, { ...flag, code: slugOf(event.target.value) })}
                />
              </label>
              <label>
                Name on the chip
                <input type="text" value={flag.label} onChange={(event) => setFlag(at, { ...flag, label: event.target.value })} />
              </label>
              <label>
                Group
                <select
                  value={flag.category}
                  onChange={(event) => setFlag(at, { ...flag, category: event.target.value as FlagCategory })}
                >
                  {FLAG_CATEGORY_ORDER.map((category) => (
                    <option key={category} value={category}>
                      {FLAG_CATEGORY_LABEL[category]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Severity
                <select
                  value={flag.severity}
                  onChange={(event) => setFlag(at, { ...flag, severity: event.target.value as Severity })}
                >
                  {(Object.keys(SEVERITY_LABEL) as Severity[]).map((severity) => (
                    <option key={severity} value={severity}>
                      {SEVERITY_LABEL[severity]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wide">
                Tooltip
                <input type="text" value={flag.hint} onChange={(event) => setFlag(at, { ...flag, hint: event.target.value })} />
              </label>
              <button
                type="button"
                className="ghost"
                disabled={draft.raises.length === 1}
                onClick={() => set({ raises: removeAt(draft.raises, at) })}
              >
                Remove flag
              </button>
            </div>
          ))}
          <div className="modules-actions">
            <button
              type="button"
              className="ghost"
              onClick={() =>
                set({
                  raises: [
                    ...draft.raises,
                    { code: `flag-${draft.raises.length + 1}`, label: '', hint: '', category: 'custom', severity: 'warning' }
                  ]
                })
              }
            >
              Add a flag
            </button>
          </div>
        </fieldset>
      ) : (
        <fieldset>
          <legend>Written for</legend>
          <p className="section-hint">
            The flags this script is meant to fix. They are offered first when you pick a flag&rsquo;s repair; nothing is
            bound until you do that.
          </p>
          <div className="script-form-chips">
            {draft.suggestedFlags.map((flag) => (
              <span className="chip" key={flag}>
                {flags.find((known) => known.id === flag)?.label ?? flag}
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Remove ${flag}`}
                  onClick={() => set({ suggestedFlags: draft.suggestedFlags.filter((other) => other !== flag) })}
                >
                  ×
                </button>
              </span>
            ))}
            <select
              value=""
              onChange={(event) =>
                event.target.value && set({ suggestedFlags: [...draft.suggestedFlags, event.target.value] })
              }
            >
              <option value="">Add a flag…</option>
              {flags
                .filter((flag) => !draft.suggestedFlags.includes(flag.id))
                .map((flag) => (
                  <option key={flag.id} value={flag.id}>
                    {flag.label}
                  </option>
                ))}
            </select>
          </div>
        </fieldset>
      )}

      {problems.length > 0 ? (
        <ul className="module-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="module-problems">{error}</p> : null}
      <div className="modules-actions">
        <button type="button" disabled={busy || problems.length > 0} onClick={() => void save()}>
          {isNew ? 'Save script' : 'Save changes'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <span className="muted">
          {isNew ? 'It runs only once you approve it.' : 'Saving withdraws its approval until you approve it again.'}
        </span>
        <span className="spacer" />
        {!isNew ? (
          <button type="button" className="ghost" onClick={() => void remove()}>
            Delete script
          </button>
        ) : null}
      </div>
    </div>
  )
}
