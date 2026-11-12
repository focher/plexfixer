import { useEffect, useRef, useState } from 'react'
import type { CodecKind } from '@shared/plex/codecs.js'
import { formatAudioCodec, formatVideoCodec } from '../format.js'

export interface CodecPickerProps {
  kind: CodecKind
  counts: Map<string, number>
  active: Set<string>
  onToggle: (codec: string) => void
  onClear: () => void
}

const KIND_LABEL: Record<CodecKind, string> = { video: 'Video', audio: 'Audio' }

/**
 * A chip that opens a checklist of the codecs in the library, with counts.
 *
 * A dropdown rather than a row of chips: a library can carry a dozen audio
 * codecs, and these are a second axis next to the work chips, not the main one.
 */
export default function CodecPicker(props: CodecPickerProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const format = props.kind === 'video' ? formatVideoCodec : formatAudioCodec

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // A ticked codec stays listed even at zero, so it can still be unticked.
  const options = [...new Set([...props.counts.keys(), ...props.active])]
    .map((codec) => ({ codec, count: props.counts.get(codec) ?? 0 }))
    .sort((a, b) => b.count - a.count || format(a.codec).localeCompare(format(b.codec)))

  // One codec across the whole library is nothing to choose between.
  if (options.length <= 1 && props.active.size === 0) return null

  const on = props.active.size > 0
  const summary =
    props.active.size === 0
      ? 'Any'
      : props.active.size === 1
        ? format([...props.active][0])
        : `${props.active.size} codecs`

  return (
    <div className="codec-picker" ref={rootRef}>
      <button
        className={`chip${on ? ' on' : ''}`}
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`Show only files with these ${props.kind} codecs`}
      >
        {KIND_LABEL[props.kind]}: {summary}
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className="codec-menu" role="listbox" aria-multiselectable="true" aria-label={`${KIND_LABEL[props.kind]} codecs`}>
          <button className="ghost codec-any" onClick={props.onClear} disabled={!on}>
            Any {props.kind} codec
          </button>
          {options.map(({ codec, count }) => (
            <label key={codec} className="codec-option" role="option" aria-selected={props.active.has(codec)}>
              <input type="checkbox" checked={props.active.has(codec)} onChange={() => props.onToggle(codec)} />
              <span className="codec-name">{format(codec)}</span>
              <span className="count">{count}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}
