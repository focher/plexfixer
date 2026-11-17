import { usePopover } from '../usePopover.js'

export interface MenuButtonItem {
  key: string
  label: string
  /** A second, muted line: what the action does. */
  hint: string
  disabled?: boolean
  /** Why it cannot be used, when it is disabled. */
  disabledHint?: string
  onSelect: () => void
}

export interface MenuButtonProps {
  /** The button's own text; the caret is added. */
  label: string
  /** What the button is for. */
  title: string
  disabled?: boolean
  /** What to say instead while it is disabled. */
  disabledTitle?: string
  items: MenuButtonItem[]
}

/**
 * Several actions behind one button that never moves.
 *
 * The toolbars here are built around not shifting under the pointer. A row of
 * buttons that appears with a selection moves everything beside it every time
 * a box is ticked, and buttons whose labels grow a count do the same more
 * quietly. One trigger of a settled width, and the actions underneath it.
 */
export default function MenuButton(props: MenuButtonProps): React.JSX.Element {
  const { open, setOpen, toggle, rootRef } = usePopover()
  const disabled = props.disabled ?? false
  const isOpen = open && !disabled

  return (
    <div className="menu-button" ref={rootRef}>
      <button
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={disabled ? (props.disabledTitle ?? props.title) : props.title}
      >
        {props.label}
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {isOpen ? (
        <div className="popover menu-button-popover" role="menu">
          {props.items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              className="menu-button-item"
              disabled={item.disabled}
              title={item.disabled ? item.disabledHint : undefined}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              <span className="menu-button-label">{item.label}</span>
              <span className="menu-button-hint">
                {item.disabled ? (item.disabledHint ?? item.hint) : item.hint}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
