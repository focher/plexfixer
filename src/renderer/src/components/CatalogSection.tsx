import { useState } from 'react'
import type { AppSettings } from '@shared/types.js'
import { DEFAULT_CATALOG, catalogResultFor, resolveCatalog } from '@shared/plex/catalog/resolve.js'
import { changedCount, resetSection } from '@shared/plex/catalog/edit.js'
import type { CatalogPatch } from '@shared/plex/catalog/types.js'

type OnChange = (patch: Partial<AppSettings>) => void

const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

/** Parses text as a JSON object, or says what is wrong with it. */
function readJson(text: string): { value?: Record<string, unknown>; error?: string } {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { value: value as Record<string, unknown> }
      : { error: 'Expected a JSON object.' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The status tiles, and the catalog as a whole.
 *
 * The statuses are edited as JSON: they are an ordered list of rules over
 * flags, and a text box that is checked as you type says exactly what it will
 * do. The same goes for the whole catalog — export it, change it, import it —
 * and every section can be put back the way it shipped.
 */
export default function CatalogSection({
  settings,
  onChange
}: {
  settings: AppSettings
  onChange: OnChange
}): React.JSX.Element {
  const patch = settings.catalog
  const { catalog, problems } = catalogResultFor(settings)

  const statusText = pretty({ statuses: catalog.statuses, statusRules: catalog.statusRules })
  const [statusDraft, setStatusDraft] = useState<string>()
  const [importDraft, setImportDraft] = useState<string>()
  const [copied, setCopied] = useState(false)

  // What the drafts would do, worked out as they are typed.
  const statusRead = statusDraft === undefined ? undefined : readJson(statusDraft)
  const statusCheck =
    statusRead?.value === undefined
      ? undefined
      : resolveCatalog(DEFAULT_CATALOG, {
          statuses: statusRead.value.statuses as CatalogPatch['statuses'],
          statusRules: statusRead.value.statusRules as CatalogPatch['statusRules']
        })
  const statusProblems = statusRead?.error ? [statusRead.error] : (statusCheck?.problems ?? [])

  const importRead = importDraft === undefined ? undefined : readJson(importDraft)
  const importCheck = importRead?.value === undefined ? undefined : resolveCatalog(DEFAULT_CATALOG, importRead.value)
  const importProblems = importRead?.error ? [importRead.error] : (importCheck?.problems ?? [])

  const applyStatuses = (): void => {
    if (!statusRead?.value || statusProblems.length > 0) return
    const next = {
      ...resetSection(patch, 'statuses'),
      statuses: statusRead.value.statuses as CatalogPatch['statuses'],
      statusRules: statusRead.value.statusRules as CatalogPatch['statusRules']
    }
    // Back to the shipped list is a reset, not a copy of it.
    const same =
      JSON.stringify({ s: next.statuses, r: next.statusRules }) ===
      JSON.stringify({ s: DEFAULT_CATALOG.statuses, r: DEFAULT_CATALOG.statusRules })
    onChange({ catalog: same ? resetSection(patch, 'statuses') : next })
    setStatusDraft(undefined)
  }

  const copyPatch = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(pretty(patch))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* the text is on screen to copy by hand */
    }
  }

  const sections = [
    { id: 'checks', label: 'Checks' },
    { id: 'repairs', label: 'Repairs' },
    { id: 'flags', label: 'Flags' },
    { id: 'statuses', label: 'Statuses' }
  ] as const

  return (
    <section>
      <h3>Statuses &amp; catalog</h3>
      <p className="section-hint">
        Every check raises <strong>flags</strong>; the chips above the library are those flags, and the status tiles
        are rules over them. The shipped rules are in <span className="mono">default.json</span>; only what you
        change is stored.
      </p>

      <h4 className="modules-heading">Status tiles</h4>
      <p className="section-hint">
        <span className="mono">statuses</span> are the tiles, in order. <span className="mono">statusRules</span> are
        tried top to bottom and the first that matches gives a file its status, so the last should be{' '}
        <span className="mono">{'{ "always": true }'}</span>. A condition is one of <span className="mono">any</span>,{' '}
        <span className="mono">all</span> or <span className="mono">none</span> of a list of selectors (by{' '}
        <span className="mono">flag</span>, <span className="mono">category</span>,{' '}
        <span className="mono">severity</span>, <span className="mono">remedy</span>,{' '}
        <span className="mono">repair</span>, <span className="mono">unresolved</span>), a plan{' '}
        <span className="mono">strategy</span>, or <span className="mono">and</span> / <span className="mono">or</span>{' '}
        / <span className="mono">not</span> of other conditions.
      </p>
      <textarea
        className="catalog-json mono"
        spellCheck={false}
        value={statusDraft ?? statusText}
        onChange={(event) => setStatusDraft(event.target.value)}
        rows={18}
      />
      {statusProblems.length > 0 ? (
        <ul className="module-problems">
          {statusProblems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <div className="modules-actions">
        <button disabled={statusDraft === undefined || statusProblems.length > 0} onClick={applyStatuses}>
          Save statuses
        </button>
        <button className="ghost" disabled={statusDraft === undefined} onClick={() => setStatusDraft(undefined)}>
          Discard edits
        </button>
        <span className="spacer" />
        <button
          className="ghost"
          disabled={changedCount(patch, 'statuses') === 0}
          onClick={() => {
            onChange({ catalog: resetSection(patch, 'statuses') })
            setStatusDraft(undefined)
          }}
        >
          Reset statuses
        </button>
      </div>

      <h4 className="modules-heading">What you have changed</h4>
      {problems.length > 0 ? (
        <>
          <p className="section-hint">Parts of your changes no longer apply and are being ignored:</p>
          <ul className="module-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="modules-actions">
        {sections.map((section) => (
          <button
            key={section.id}
            className="ghost"
            disabled={changedCount(patch, section.id) === 0}
            onClick={() => onChange({ catalog: resetSection(patch, section.id) })}
            title={`Put every ${section.label.toLowerCase()} entry back the way it shipped`}
          >
            Reset {section.label.toLowerCase()} ({changedCount(patch, section.id)})
          </button>
        ))}
        <span className="spacer" />
        <button className="ghost" disabled={Object.keys(patch).length === 0} onClick={() => onChange({ catalog: {} })}>
          Reset everything to defaults
        </button>
      </div>

      <div className="modules-actions">
        <button onClick={() => void copyPatch()}>{copied ? 'Copied' : 'Copy my changes as JSON'}</button>
        <button className="ghost" onClick={() => setImportDraft(importDraft === undefined ? pretty(patch) : undefined)}>
          {importDraft === undefined ? 'Import JSON…' : 'Cancel import'}
        </button>
      </div>
      {importDraft !== undefined ? (
        <>
          <textarea
            className="catalog-json mono"
            spellCheck={false}
            value={importDraft}
            onChange={(event) => setImportDraft(event.target.value)}
            rows={14}
          />
          {importProblems.length > 0 ? (
            <ul className="module-problems">
              {importProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
          <div className="modules-actions">
            <button
              disabled={!importRead?.value}
              onClick={() => {
                if (!importRead?.value) return
                onChange({ catalog: importRead.value as CatalogPatch })
                setImportDraft(undefined)
              }}
              title={importProblems.length > 0 ? 'Entries listed above will be ignored' : undefined}
            >
              Replace my changes with this
            </button>
          </div>
        </>
      ) : null}
    </section>
  )
}
