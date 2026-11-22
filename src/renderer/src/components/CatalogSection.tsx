import { useState } from 'react'
import type { AppSettings } from '@shared/types.js'
import { DEFAULT_CATALOG, catalogResultFor, resolveCatalog } from '@shared/plex/catalog/resolve.js'
import { changedCount, resetSection } from '@shared/plex/catalog/edit.js'
import StatusEditor from './StatusEditor.js'
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
  const { problems } = catalogResultFor(settings)

  const [importDraft, setImportDraft] = useState<string>()
  const [copied, setCopied] = useState(false)

  // What an import would do, worked out as it is typed.
  const importRead = importDraft === undefined ? undefined : readJson(importDraft)
  const importCheck = importRead?.value === undefined ? undefined : resolveCatalog(DEFAULT_CATALOG, importRead.value)
  const importProblems = importRead?.error ? [importRead.error] : (importCheck?.problems ?? [])

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
        are rules over them. Build the tiles and their rules here; only what you change from the shipped setup is
        stored, and each part can be put back.
      </p>

      <StatusEditor settings={settings} onChange={onChange} />

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

      <details className="catalog-advanced">
        <summary>Advanced: your changes as JSON</summary>
        <p className="section-hint">
          Everything above is stored as a small JSON document of what differs from the shipped defaults. Copy it to
          keep or share a setup, or paste one in.
        </p>
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
      </details>
    </section>
  )
}
