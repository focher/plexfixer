import { flagDef } from '@shared/plex/catalog/resolve.js'
import { FLAG_CATEGORY_LABEL, FLAG_CATEGORY_ORDER, type Catalog } from '@shared/plex/catalog/types.js'
import { codecFilterActive, type CodecCounts, type CodecFilter, type CodecKind } from '@shared/plex/codecs.js'
import CodecPicker from './CodecPicker.js'

export interface FilterBarProps {
  /** Names, groups and hides the chips. */
  catalog: Catalog
  /** How many files carry each flag; only flags present are listed. */
  counts: ReadonlyMap<string, number>
  /** The flags whose chips are on. */
  active: ReadonlySet<string>
  codecCounts: CodecCounts
  codecs: CodecFilter
  total: number
  shown: number
  onToggle: (flag: string) => void
  onToggleCodec: (kind: CodecKind, codec: string) => void
  onClearCodecs: (kind: CodecKind) => void
  /** Clears the chips and both codec pickers. */
  onClear: () => void
}

/**
 * A chip for each flag the files carry, and pickers for codecs.
 *
 * Flags no file carries are left out rather than shown greyed: on a library of
 * one shape, most of them never apply, and a row of dead chips is noise. A chip
 * that is on stays even when the other filters leave it nothing, so it can be
 * switched off. Selecting several widens the table rather than narrowing it —
 * these answer "show me these kinds", not "files that are all of these at once".
 *
 * Chips are grouped by the catalog's categories and, within one, follow the
 * catalog's order — which is the order the checks run in.
 */
export default function FilterBar(props: FilterBarProps): React.JSX.Element | null {
  const catalogOrder = Object.keys(props.catalog.flags)
  const rank = (flag: string): number => {
    const at = catalogOrder.indexOf(flag)
    return at === -1 ? catalogOrder.length : at
  }
  const available = [...new Set([...props.counts.keys(), ...props.active])]
    .filter((flag) => flagDef(props.catalog, flag).chip || props.active.has(flag))
    .sort(
      (a, b) =>
        FLAG_CATEGORY_ORDER.indexOf(flagDef(props.catalog, a).category) -
          FLAG_CATEGORY_ORDER.indexOf(flagDef(props.catalog, b).category) || rank(a) - rank(b)
    )
  const anyActive = props.active.size > 0 || codecFilterActive(props.codecs)
  const pickers = (['video', 'audio'] as const).map((kind) => (
    <CodecPicker
      key={kind}
      kind={kind}
      counts={props.codecCounts[kind]}
      active={props.codecs[kind]}
      onToggle={(codec) => props.onToggleCodec(kind, codec)}
      onClear={() => props.onClearCodecs(kind)}
    />
  ))
  const hasPickers = (['video', 'audio'] as const).some(
    (kind) => props.codecCounts[kind].size > 1 || props.codecs[kind].size > 0
  )
  if (available.length === 0 && !hasPickers && !anyActive) return null

  return (
    <div className="filterbar">
      {available.length > 0 ? <span className="muted nowrap">Show</span> : null}
      {available.map((flag, index) => {
        const on = props.active.has(flag)
        const def = flagDef(props.catalog, flag)
        const previous = index > 0 ? flagDef(props.catalog, available[index - 1] as string).category : undefined
        return (
          <span key={flag} className="chip-slot">
            {previous !== undefined && previous !== def.category ? (
              <span className="filter-divider" aria-hidden="true" />
            ) : null}
            <button
              className={`chip${on ? ' on' : ''}`}
              onClick={() => props.onToggle(flag)}
              aria-pressed={on}
              title={`${FLAG_CATEGORY_LABEL[def.category]}: ${def.hint}`}
            >
              {def.label}
              <span className="count">{props.counts.get(flag) ?? 0}</span>
            </button>
          </span>
        )
      })}
      {hasPickers ? (
        <>
          {available.length > 0 ? <span className="filter-divider" aria-hidden="true" /> : null}
          {pickers}
        </>
      ) : null}
      {anyActive ? (
        <>
          <span className="spacer" />
          <span className="muted nowrap">
            {props.shown} of {props.total}
          </span>
          <button className="ghost" onClick={props.onClear}>
            Clear
          </button>
        </>
      ) : null}
    </div>
  )
}
