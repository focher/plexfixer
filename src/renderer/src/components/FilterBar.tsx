import type { ResultFacet } from '@shared/plex/facets.js'
import { FACET_INFO, FACET_ORDER } from '@shared/plex/facets.js'

export interface FilterBarProps {
  counts: Record<ResultFacet, number>
  active: Set<ResultFacet>
  total: number
  shown: number
  onToggle: (facet: ResultFacet) => void
  onClear: () => void
}

/**
 * Chips for narrowing the table to one kind of work.
 *
 * Facets with no matching file are left out rather than shown greyed: on a
 * library of one shape, most of them never apply, and a row of dead chips is
 * noise. Selecting several widens the table rather than narrowing it — these
 * answer "show me these kinds", not "files that are all of these at once".
 */
export default function FilterBar(props: FilterBarProps): React.JSX.Element | null {
  const available = FACET_ORDER.filter((facet) => props.counts[facet] > 0)
  if (available.length === 0) return null

  return (
    <div className="filterbar">
      <span className="muted nowrap">Show</span>
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
      {props.active.size > 0 ? (
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
