import type { ResultFacet } from '@shared/plex/facets.js'
import { FACET_INFO, FACET_ORDER } from '@shared/plex/facets.js'
import { codecFilterActive, type CodecCounts, type CodecFilter, type CodecKind } from '@shared/plex/codecs.js'
import CodecPicker from './CodecPicker.js'

export interface FilterBarProps {
  counts: Record<ResultFacet, number>
  active: Set<ResultFacet>
  codecCounts: CodecCounts
  codecs: CodecFilter
  total: number
  shown: number
  onToggle: (facet: ResultFacet) => void
  onToggleCodec: (kind: CodecKind, codec: string) => void
  onClearCodecs: (kind: CodecKind) => void
  /** Clears the chips and both codec pickers. */
  onClear: () => void
}

/**
 * Chips for narrowing the table to one kind of work, and pickers for codecs.
 *
 * Facets with no matching file are left out rather than shown greyed: on a
 * library of one shape, most of them never apply, and a row of dead chips is
 * noise. Selecting several widens the table rather than narrowing it — these
 * answer "show me these kinds", not "files that are all of these at once".
 */
export default function FilterBar(props: FilterBarProps): React.JSX.Element | null {
  const available = FACET_ORDER.filter((facet) => props.counts[facet] > 0)
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
      {available.map((facet) => {
        const on = props.active.has(facet)
        return (
          <button
            key={facet}
            className={`chip${on ? ' on' : ''}`}
            onClick={() => props.onToggle(facet)}
            aria-pressed={on}
            title={FACET_INFO[facet].hint}
          >
            {FACET_INFO[facet].label}
            <span className="count">{props.counts[facet]}</span>
          </button>
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
