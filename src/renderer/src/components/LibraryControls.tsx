/**
 * The two controls that steer the list: search, and everything else.
 *
 * They sit at the right of the line the four counts are on, because that is
 * where the list's controls belong — beside what they control, not stacked
 * above it in rows of their own. Between them they replaced three rows of
 * chrome: a full-width search field, a row of filter chips, and a toggle.
 *
 * **Search** is a magnifying glass until it is wanted, and widens into a field
 * when it is clicked. A library of four hundred files is searched often enough
 * to deserve a key away, and seldom enough that a permanently open field is a
 * permanently empty one.
 *
 * **The filter** is one button holding every way of narrowing the list, each a
 * checkbox, all of them multi-select. The chips it replaced said the same
 * things, but they were a row that grew with the library — eight, twelve,
 * fifteen of them — and a row that reflows as you scan it cannot be read.
 */

import { useEffect, useRef, useState } from 'react'
import type { ResultFacet } from '@shared/plex/facets.js'
import { FACET_INFO, FACET_ORDER } from '@shared/plex/facets.js'
import { codecFilterActive, type CodecCounts, type CodecFilter, type CodecKind } from '@shared/plex/codecs.js'
import { FilterIcon, SearchIcon } from './icons.js'

export interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  /** Shown beside the field, e.g. "12 of 400". */
  summary?: string
}

export function SearchBox({ value, onChange, summary }: SearchBoxProps): React.JSX.Element {
  // Something typed keeps the field open: closing over a live search would
  // hide the reason the list is short.
  const [open, setOpen] = useState(value.trim().length > 0)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  return (
    <div className={`searchbox${open ? ' open' : ''}`}>
      <button
        className="icon-button"
        aria-label="Search files and folders"
        aria-expanded={open}
        title="Search files and folders"
        onClick={() => {
          if (open && value.trim() === '') setOpen(false)
          else setOpen(true)
        }}
      >
        <SearchIcon />
      </button>
      <input
        ref={field}
        type="search"
        value={value}
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        placeholder="Search files and folders"
        aria-label="Search files and folders"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          onChange('')
          setOpen(false)
        }}
        onBlur={() => {
          if (value.trim() === '') setOpen(false)
        }}
      />
      {open && summary ? <span className="muted nowrap searchbox-summary">{summary}</span> : null}
    </div>
  )
}

export interface HidePassedProps {
  on: boolean
  count: number
  onChange: (hide: boolean) => void
}

/**
 * "Hide passed", kept out of the filter menu.
 *
 * It was in there for a while, as one checkbox among a dozen. It is not one of
 * them: the others answer "show me this kind of problem" and are reached for
 * occasionally, while this one is the switch between looking at a library and
 * looking at the work in it — flicked constantly, by everybody. A thing used
 * that often does not live behind a click.
 */
export function HidePassed({ on, count, onChange }: HidePassedProps): React.JSX.Element {
  return (
    <label className={`toggle${on ? ' on' : ''}`} title="Leave out files with nothing to do">
      <input type="checkbox" checked={on} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch" aria-hidden="true" />
      Hide passed
      <span className="count">{count}</span>
    </label>
  )
}

export interface FilterMenuProps {
  counts: Record<ResultFacet, number>
  active: Set<ResultFacet>
  codecCounts: CodecCounts
  codecs: CodecFilter
  onToggle: (facet: ResultFacet) => void
  onToggleCodec: (kind: CodecKind, codec: string) => void
  /** Clears the facets and both codec pickers. */
  onClear: () => void
}

/** One line in the menu: a checkbox, a label, and how many it would leave. */
function Check({
  checked,
  label,
  hint,
  count,
  onChange
}: {
  checked: boolean
  label: string
  hint?: string
  count?: number
  onChange: () => void
}): React.JSX.Element {
  return (
    <label className="filter-check" title={hint}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="filter-check-label">{label}</span>
      {count !== undefined ? <span className="count">{count}</span> : null}
    </label>
  )
}

export function FilterMenu(props: FilterMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)

  // Click anywhere else and it closes, which is what a menu does. Without it
  // the only way out is the button that opened it.
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  // Only what this library actually contains. A row of filters for problems no
  // file here has is a longer menu that answers nothing.
  const facets = FACET_ORDER.filter((facet) => props.counts[facet] > 0)
  const codecKinds = (['video', 'audio'] as const).filter(
    (kind) => props.codecCounts[kind].size > 1 || props.codecs[kind].size > 0
  )

  const activeCount = props.active.size + props.codecs.video.size + props.codecs.audio.size

  return (
    <div className="filter-menu" ref={wrapper}>
      <button
        className={`icon-button${activeCount > 0 ? ' on' : ''}`}
        aria-expanded={open}
        aria-label="Filter the list"
        title="Filter the list"
        onClick={() => setOpen((current) => !current)}
      >
        <FilterIcon />
        {activeCount > 0 ? <span className="filter-badge">{activeCount}</span> : null}
      </button>

      {open ? (
        <div className="filter-popover" role="dialog" aria-label="Filters">
          {facets.length > 0 ? (
            <div className="filter-group">
              <div className="filter-group-title">What needs doing</div>
              {facets.map((facet) => (
                <Check
                  key={facet}
                  checked={props.active.has(facet)}
                  label={FACET_INFO[facet].label}
                  hint={FACET_INFO[facet].hint}
                  count={props.counts[facet]}
                  onChange={() => props.onToggle(facet)}
                />
              ))}
            </div>
          ) : null}

          {codecKinds.map((kind) => (
            <div className="filter-group" key={kind}>
              <div className="filter-group-title">{kind === 'video' ? 'Video codec' : 'Audio codec'}</div>
              {[...props.codecCounts[kind].entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([codec, count]) => (
                  <Check
                    key={codec}
                    checked={props.codecs[kind].has(codec)}
                    label={codec.toUpperCase()}
                    count={count}
                    onChange={() => props.onToggleCodec(kind, codec)}
                  />
                ))}
            </div>
          ))}

          {activeCount > 0 ? (
            <div className="filter-foot">
              <button className="ghost" onClick={props.onClear}>
                Clear all
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Whether anything in the menu is narrowing the list. */
export function filtersActive(active: Set<ResultFacet>, codecs: CodecFilter): boolean {
  return active.size > 0 || codecFilterActive(codecs)
}
